import * as Tone from 'tone';
import { PART_IDS, type PartId, type Score } from '../score/score';
import type { Analysis } from '../theory/analysis';
import { Conductor } from '../performance/conductor';
import { EnsembleState } from '../performance/ensemble';
import { Musician, type Gesture } from '../performance/musician';
import { PERSONAS } from '../performance/personas';
import { clamp, Rng } from '../performance/random';
import type { GesturePlan, PlannedNote } from '../performance/types';
import { BeatFollower } from '../conductor/follower';
import { InstrumentChannel } from './channel';
import { GestureVoice } from './voice';

/** How far ahead (s) musicians decide what to play. */
const LOOKAHEAD = 0.45;
const START_DELAY = 0.3;

export type EngineState = 'idle' | 'armed' | 'playing';

export interface PartSnapshot {
  note: PlannedNote | null;
  /** Current loudness of the part (dB), following the real envelope. */
  db: number;
  vibratoCents: number;
  intent: string | null;
  intentAge: number;
  /** The bow stroke / breath in progress; strokes alternate direction. */
  gesture: { start: number; end: number; stroke: number } | null;
}

/** A conductor's beat, as seen by the camera. */
export interface Ictus {
  /** Audio-context time of the beat. */
  time: number;
  /** Gesture size relative to the space between the guide lines (1 = full). */
  amplitude: number;
  /** Time since the previous beat (s), if there was a recent one. */
  interval: number | null;
}

export interface FollowInfo {
  /** Beat of the bar (1-based) the ensemble placed this ictus on. */
  beatInBar: number;
  qpm: number;
  /** How far the ensemble was ahead (+) or behind (-) the beat, in ms. */
  offsetMs: number;
}

interface Pending {
  musician: Musician;
  gesture: Gesture;
  beat: number;
}

/**
 * Runs a live performance. Nothing is pre-rendered: a scheduler wakes up
 * many times per second, and the musicians plan each gesture just before it
 * is due, publishing it so the others can listen, after which it is
 * synthesised with Web Audio automation via Tone.js.
 *
 * With a live conductor the ensemble first waits (armed) for a count-in beat
 * and comes in on the next, then follows each beat: it adjusts its tempo to the conductor's
 * and gradually corrects any drift in phase, moving notes it has already
 * planned rather than waiting for the next phrase.
 */
export class PerformanceEngine {
  conductor: Conductor | null = null;
  musicians: Musician[] = [];
  readonly plans: GesturePlan[] = [];
  onEnd: (() => void) | null = null;
  /** Quarter-note beats per conducted beat: 2 = conducting "in 2". */
  beatUnit = 2;

  private channels = {} as Record<PartId, InstrumentChannel>;
  private master: Tone.Gain | null = null;
  /** Final stage before the speakers. */
  output: Tone.ToneAudioNode | null = null;
  private reverb: Tone.Reverb | null = null;
  private extra: Tone.ToneAudioNode[] = [];
  private clock: Tone.Clock | null = null;
  private voices = new Set<GestureVoice>();
  private pending: Pending[] = [];
  private origin = 0;
  private _state: EngineState = 'idle';
  private lastIntent = new Map<PartId, { text: string; at: number }>();
  private strokes = new WeakMap<GesturePlan, number>();
  private strokeCount = new Map<PartId, number>();
  private follower = new BeatFollower(2, 0.5);

  constructor(private readonly score: Score, private readonly analysis: Analysis) {}

  get state(): EngineState {
    return this._state;
  }

  get isPlaying(): boolean {
    return this._state === 'playing';
  }

  get isLive(): boolean {
    return !!this.conductor?.isLive;
  }

  /** Performance time in seconds (negative during the count-in). */
  get time(): number {
    return this.isPlaying ? Tone.now() - this.origin : 0;
  }

  /**
   * Audio-context time of a moment on the performance.now() clock (s),
   * allowing for output latency so a beat lines up with what is heard.
   */
  contextTimeAt(perfSeconds: number): number {
    const ctx = Tone.getContext().rawContext as unknown as AudioContext;
    const latency = ctx.outputLatency || ctx.baseLatency || 0;
    return ctx.currentTime - (performance.now() / 1000 - perfSeconds) - latency;
  }

  /** Create the audio graph; call from a user gesture. */
  async ensureGraph(): Promise<void> {
    if (this.master) return;
    // iPhones mute Web Audio with the silent switch unless it is media playback
    const session = (navigator as Navigator & { audioSession?: { type: string } }).audioSession;
    if (session) session.type = 'playback';
    await Tone.start();
    // gentle bus compression, then a limiter and a soft clipper (linear
    // below 0.7) to catch the few transients a compressor lets through
    const clipper = new Tone.WaveShaper((x) => {
      const a = Math.abs(x);
      return a < 0.7 ? x : Math.sign(x) * (0.7 + 0.29 * Math.tanh((a - 0.7) / 0.29));
    }, 4096).toDestination();
    const limiter = new Tone.Limiter(-2).connect(clipper);
    const comp = new Tone.Compressor({ threshold: -20, ratio: 2.5, knee: 12, attack: 0.02, release: 0.3 });
    const makeup = new Tone.Gain(Tone.dbToGain(3.5));
    this.master = new Tone.Gain(Tone.dbToGain(1));
    this.output = clipper;
    this.reverb = new Tone.Reverb({ decay: 2.4, preDelay: 0.025, wet: 1 });
    await this.reverb.ready;
    const reverbReturn = new Tone.Gain(0.55);
    const hallEq = new Tone.Filter({ type: 'highshelf', frequency: 4500, gain: -6 });
    this.reverb.chain(hallEq, reverbReturn, this.master);
    this.master.chain(comp, makeup, limiter);
    this.extra.push(clipper, limiter, comp, makeup, reverbReturn, hallEq);
    for (const id of PART_IDS) this.channels[id] = new InstrumentChannel(PERSONAS[id], this.master, this.reverb);
  }

  /** Start straight away, the built-in conductor setting the tempo. */
  async play(expressive: boolean, seed: number): Promise<void> {
    await this.prepare(expressive, seed, false);
    this.begin(Tone.now() + START_DELAY);
  }

  /** Get ready to follow a live conductor; nothing sounds until the downbeat. */
  async arm(expressive: boolean, seed: number): Promise<void> {
    await this.prepare(expressive, seed, true);
    this._state = 'armed';
  }

  private async prepare(expressive: boolean, seed: number, live: boolean): Promise<void> {
    await this.ensureGraph();
    this.stop();
    const rng = new Rng(seed);
    const ensemble = new EnsembleState();
    const conductor = new Conductor(this.score, this.analysis, rng.fork(1), expressive, live);
    this.conductor = conductor;
    this.musicians = PART_IDS.map(
      (id, i) => new Musician(id, this.score, this.analysis, conductor, ensemble, rng.fork(100 + i), expressive),
    );
    this.pending = this.musicians
      .flatMap((m) => m.gestures.map((gesture) => ({ musician: m, gesture, beat: gesture.notes[0].start })))
      .sort((a, b) => a.beat - b.beat);
    this.plans.length = 0;
    this.lastIntent.clear();
    this.strokeCount.clear();
  }

  private begin(origin: number): void {
    this.origin = origin;
    for (const id of PART_IDS) this.channels[id].start(Tone.now());
    this._state = 'playing';
    this.schedule();
    this.clock = new Tone.Clock(() => this.schedule(), 25);
    this.clock.start();
  }

  stop(): void {
    const wasPlaying = this._state === 'playing';
    this._state = 'idle';
    if (!wasPlaying) return;
    this.clock?.stop();
    this.clock?.dispose();
    this.clock = null;
    const now = Tone.now();
    for (const v of this.voices) v.release(now);
    const voices = [...this.voices];
    this.voices.clear();
    setTimeout(() => voices.forEach((v) => v.dispose()), 400);
    for (const id of PART_IDS) this.channels[id]?.stop(now + 0.3);
  }

  /**
   * A beat from the live conductor. When armed, the first beat counts in and
   * the second starts the performance at the tempo the two beats set.
   * While playing, the ensemble follows: the beat is matched to the nearest
   * conducted beat of the score, the tempo moves towards the conductor's,
   * and part of the drift is corrected by the next beat, as players do.
   */
  ictus(beat: Ictus): FollowInfo | null {
    const c = this.conductor;
    if (!c?.isLive) return null;
    const unit = this.beatUnit;
    this.applyGestureSize(beat.amplitude);

    if (this._state === 'armed') {
      if (beat.interval === null) return null; // the count-in beat
      // a plausible Allegro to begin; the ensemble adapts from the next beat
      const spb = clamp(beat.interval / unit, 60 / 144, 60 / 84);
      c.setInitialTempo(spb);
      this.follower = new BeatFollower(unit, spb);
      this.follower.start(spb);
      // a short reaction delay, but never in the past
      this.begin(Math.max(beat.time + 0.06, Tone.now() + 0.03));
      return { beatInBar: 1, qpm: 60 / spb, offsetMs: 0 };
    }
    if (this._state !== 'playing') return null;

    const t = beat.time - this.origin;           // when the conductor beat
    const now = Tone.now() - this.origin + 0.015; // the earliest we can change
    if (c.beatAt(t) >= this.score.totalBeats) return null;
    this.follower.unit = unit;
    const { spb, target, error } = this.follower.follow(c, t, now);
    this.retime(c.follow(now, spb), now);

    return {
      beatInBar: Math.floor((target % this.score.beatsPerBar) / unit) + 1,
      qpm: 60 / spb,
      offsetMs: ((error * 60) / c.qpmAt(target)) * 1000,
    };
  }

  /**
   * Bigger gestures ask for more sound, smaller ones for less. Averaged over
   * about a bar, since beat patterns naturally alternate small and large.
   */
  private applyGestureSize(amplitude: number): void {
    if (!this.conductor) return;
    const target = clamp((amplitude - 0.75) * 10, -6, 5);
    this.conductor.gestureDb = 0.75 * this.conductor.gestureDb + 0.25 * target;
  }

  /** Move everything already planned after `from` onto the new tempo. */
  private retime(remap: (t: number) => number, from: number): void {
    const move = <T extends { t: number }>(points: T[]) => {
      for (const p of points) if (p.t > from) p.t = remap(p.t);
    };
    for (const plan of this.plans) {
      if (plan.end <= from) continue;
      move(plan.level);
      move(plan.pitch);
      move(plan.vibrato);
      move(plan.noise);
      for (const n of plan.notes) {
        if (n.t0 > from) n.t0 = remap(n.t0);
        if (n.t1 > from) n.t1 = remap(n.t1);
      }
      if (plan.start > from) plan.start = remap(plan.start);
      plan.end = remap(plan.end);
    }
    const at = this.origin + from;
    for (const v of this.voices) if (v.endAt > at) v.reschedule(at);
  }

  private schedule(): void {
    if (!this.isPlaying || !this.conductor) return;
    const now = Tone.now() - this.origin;
    const horizon = now + LOOKAHEAD;

    // gather the gestures that are due, then let the melody plan first so
    // the accompanists can listen to it
    const due: Pending[] = [];
    while (this.pending.length && this.conductor.timeOf(this.pending[0].beat) - 0.05 < horizon) {
      due.push(this.pending.shift()!);
    }
    due.sort((a, b) => {
      const la = this.analysis.leaderAt(a.beat) === a.musician.part ? 0 : 1;
      const lb = this.analysis.leaderAt(b.beat) === b.musician.part ? 0 : 1;
      return a.beat - b.beat || la - lb;
    });
    for (const p of due) {
      const plan = p.musician.plan(p.gesture);
      const stroke = this.strokeCount.get(plan.part) ?? 0;
      this.strokeCount.set(plan.part, stroke + 1);
      this.strokes.set(plan, stroke);
      this.plans.push(plan);
      this.voices.add(new GestureVoice(plan, this.channels[p.musician.part], p.musician.persona, this.origin));
    }

    // tidy up finished voices
    const audioNow = Tone.now();
    for (const v of this.voices) {
      if (v.endAt < audioNow - 0.2) {
        v.dispose();
        this.voices.delete(v);
      }
    }
    if (this.plans.length > 400) this.plans.splice(0, this.plans.length - 400);

    if (!this.pending.length && now > this.conductor.duration + 3) {
      this.stop();
      this.onEnd?.();
    }
  }

  /** What a part is doing at the current moment, for the stage view. */
  snapshot(part: PartId, time: number): PartSnapshot {
    let note: PlannedNote | null = null;
    let db = -90;
    let vibrato = 0;
    let gesture: PartSnapshot['gesture'] = null;
    for (let i = this.plans.length - 1; i >= 0; i--) {
      const g = this.plans[i];
      if (g.part !== part || g.start > time || g.end < time) continue;
      const level = interpolate(g.level.map((p) => [p.t, p.db]), time);
      if (level > db) {
        db = level;
        vibrato = g.vibrato.length ? interpolate(g.vibrato.map((p) => [p.t, p.cents]), time) : 0;
        note = g.notes.find((n) => n.t0 <= time && n.t1 + 0.02 >= time) ?? note;
        gesture = { start: g.start, end: g.notes[g.notes.length - 1].t1, stroke: this.strokes.get(g) ?? 0 };
      }
    }
    if (note?.intent) {
      const last = this.lastIntent.get(part);
      if (!last || last.text !== note.intent) this.lastIntent.set(part, { text: note.intent, at: time });
    }
    const intent = this.lastIntent.get(part);
    return {
      note,
      db,
      vibratoCents: vibrato,
      intent: intent?.text ?? null,
      intentAge: intent ? time - intent.at : Infinity,
      gesture,
    };
  }
}

function interpolate(points: [number, number][], t: number): number {
  if (!points.length) return 0;
  if (t <= points[0][0]) return points[0][1];
  for (let i = 1; i < points.length; i++) {
    const [t1, v1] = points[i];
    if (t <= t1) {
      const [t0, v0] = points[i - 1];
      return t1 === t0 ? v1 : v0 + ((v1 - v0) * (t - t0)) / (t1 - t0);
    }
  }
  return points[points.length - 1][1];
}
