import type { Score } from '../score/score';
import type { Analysis } from '../theory/analysis';
import type { Phrase } from '../theory/phrases';
import { clamp, Rng, smoothstep } from './random';

const STEPS_PER_BEAT = 16;

/** A stretch of steady tempo set by a live conductor. */
interface Segment {
  beat: number;
  time: number;
  /** Seconds per quarter-note beat. */
  spb: number;
}

export interface PhraseShape {
  phrase: Phrase;
  /** Tempo swing of the phrase arch (fraction of the tempo). */
  arch: number;
  /** Slowing into the cadence (fraction of the tempo). */
  ritard: number;
  /** Breath taken after the arrival before the next entry (fraction). */
  breath: number;
  /** Dynamic swell of the phrase arch (dB). */
  swellDb: number;
}

/**
 * The ensemble's shared sense of time. Rather than a metronome, it is a tempo
 * map shaped by the phrase structure, after the KTH performance rules
 * (Friberg, Bresin & Sundberg): each phrase pushes forward towards its high
 * point and relaxes into its cadence, harmonic tension broadens the pulse,
 * cadences are followed by a breath, and the excerpt ends with a final
 * ritardando. The shape is redrawn for every performance.
 *
 * In live mode a human conducts instead: the tempo map becomes a chain of
 * steady segments that the ensemble extends each time it follows a beat.
 */
export class Conductor {
  baseQpm: number;
  readonly shapes: PhraseShape[];
  /** Extra loudness (dB) asked for by a live conductor's gesture size. */
  gestureDb = 0;
  private readonly seconds: Float64Array;
  private readonly factors: Float64Array;
  private segments: Segment[] | null = null;

  constructor(
    private readonly score: Score,
    private readonly analysis: Analysis,
    rng: Rng,
    readonly expressive: boolean,
    live = false,
  ) {
    this.baseQpm = expressive ? rng.gauss(116, 2) : 120;
    if (live) this.segments = [{ beat: 0, time: 0, spb: 60 / this.baseQpm }];
    this.shapes = analysis.phrases.map((phrase) => ({
      phrase,
      arch: expressive ? rng.range(0.035, 0.06) : 0,
      ritard: expressive ? rng.range(0.08, 0.14) * phrase.closure : 0,
      breath: expressive ? rng.range(0.15, 0.28) * phrase.closure : 0,
      swellDb: expressive ? rng.range(2.2, 3.4) : 0,
    }));

    const n = score.totalBeats * STEPS_PER_BEAT;
    this.factors = new Float64Array(n + 1);
    this.seconds = new Float64Array(n + 1);
    let drift = 0;
    for (let i = 0; i <= n; i++) {
      const beat = i / STEPS_PER_BEAT;
      if (expressive) drift = 0.995 * drift + rng.gauss(0, 0.0012);
      this.factors[i] = expressive ? this.tempoFactor(beat) * (1 + drift) : 1;
      if (i > 0) {
        const qpm = this.baseQpm * this.factors[i - 1];
        this.seconds[i] = this.seconds[i - 1] + 60 / qpm / STEPS_PER_BEAT;
      }
    }
  }

  get isLive(): boolean {
    return this.segments !== null;
  }

  get duration(): number {
    return this.segments ? this.timeOf(this.score.totalBeats) : this.seconds[this.seconds.length - 1];
  }

  /** Live mode: the tempo the conductor's count-in set. */
  setInitialTempo(spb: number): void {
    if (!this.segments) return;
    this.segments = [{ beat: 0, time: 0, spb }];
    this.baseQpm = 60 / spb;
  }

  /**
   * Live mode: from `time` onwards play at `spb` seconds per beat. Returns a
   * function that maps a time planned under the old tempo to the new one, so
   * notes that were already planned can be moved.
   */
  follow(time: number, spb: number): (t: number) => number {
    if (!this.segments) return (t) => t;
    const old = this.segments.slice();
    const beat = this.beatAt(time);
    this.segments = this.segments.filter((s) => s.time < time);
    this.segments.push({ beat, time, spb });
    return (t) => (t <= time ? t : this.timeOf(beatInSegments(old, t)));
  }

  shapeAt(beat: number): PhraseShape {
    return this.shapes.find((s) => beat >= s.phrase.start && beat < s.phrase.end) ?? this.shapes[this.shapes.length - 1];
  }

  /** Performance time (s) at which a score beat falls. */
  timeOf(beat: number): number {
    if (this.segments) {
      const b = Math.max(0, beat);
      let seg = this.segments[0];
      for (const s of this.segments) if (s.beat <= b) seg = s;
      return seg.time + (b - seg.beat) * seg.spb;
    }
    const x = clamp(beat, 0, this.score.totalBeats) * STEPS_PER_BEAT;
    const i = Math.min(Math.floor(x), this.seconds.length - 2);
    return this.seconds[i] + (this.seconds[i + 1] - this.seconds[i]) * (x - i);
  }

  /** Score beat sounding at a performance time. */
  beatAt(time: number): number {
    if (this.segments) return clamp(beatInSegments(this.segments, time), 0, this.score.totalBeats);
    let lo = 0, hi = this.seconds.length - 1;
    if (time <= 0) return 0;
    if (time >= this.seconds[hi]) return this.score.totalBeats;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (this.seconds[mid] <= time) lo = mid;
      else hi = mid;
    }
    const frac = (time - this.seconds[lo]) / (this.seconds[hi] - this.seconds[lo]);
    return (lo + frac) / STEPS_PER_BEAT;
  }

  qpmAt(beat: number): number {
    if (this.segments) {
      let seg = this.segments[0];
      for (const s of this.segments) if (s.beat <= beat) seg = s;
      return 60 / seg.spb;
    }
    const i = clamp(Math.round(beat * STEPS_PER_BEAT), 0, this.factors.length - 1);
    return this.baseQpm * this.factors[i];
  }

  /** Phrase-arch dynamic offset (dB) at a beat, peaking at the phrase climax. */
  archDb(beat: number): number {
    const s = this.shapeAt(beat);
    return s.swellDb * (arch(s.phrase, beat) - 0.55);
  }

  private tempoFactor(beat: number): number {
    const s = this.shapeAt(beat);
    const p = s.phrase;
    let f = 1 + s.arch * (arch(p, beat) - 0.55);

    // ritardando into the arrival
    const into = (beat - (p.end - 1.5)) / 1.5;
    if (into > 0 && into <= 1) f *= 1 - s.ritard * smoothstep(into);

    // a breath just after the previous phrase's arrival, before the entry
    const prev = this.shapes[p.index - 1];
    if (prev) {
      const after = beat - p.start;
      if (after >= 0 && after < 0.75) f *= 1 - prev.breath * Math.sin((Math.PI * after) / 0.75) * 0.6;
    }

    // harmonic tension broadens the pulse slightly
    f *= 1 - 0.035 * (this.analysis.chordAt(beat).tension - 0.4);

    // final ritardando over the last bar of the excerpt
    const end = this.score.totalBeats;
    const fin = (beat - (end - 4)) / 4;
    if (fin > 0) f *= 1 - 0.2 * smoothstep(fin);
    return f;
  }
}

function beatInSegments(segments: Segment[], time: number): number {
  let seg = segments[0];
  for (const s of segments) if (s.time <= time) seg = s;
  return seg.beat + (time - seg.time) / seg.spb;
}

/**
 * Phrase arch 0..1, rising to 1 at the phrase's climax and falling after it.
 * The exponent maps the climax position to the sine's peak.
 */
export function arch(p: Phrase, beat: number): number {
  const len = Math.max(1, p.end - p.start);
  const x = clamp((beat - p.start) / len, 0, 1);
  const xc = clamp((p.climax - p.start) / len, 0.2, 0.85);
  const k = Math.log(0.5) / Math.log(xc);
  return Math.sin(Math.PI * Math.pow(x, k));
}
