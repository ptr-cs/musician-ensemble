import type { Part, PartId, Score, ScoreNote } from '../score/score';
import type { Analysis } from '../theory/analysis';
import type { NoteHarmony } from '../theory/nct';
import { metricWeight, noteName, OPEN_STRINGS, pc } from '../theory/pitch';
import type { Role } from '../theory/roles';
import type { Conductor } from './conductor';
import type { EnsembleState } from './ensemble';
import { PERSONAS, type Persona } from './personas';
import { clamp, Rng } from './random';
import type { GesturePlan, LevelPoint, NoisePoint, PitchPoint, PlannedNote, VibratoPoint } from './types';

/** Notes that sound as one bow stroke / one breath. */
export interface Gesture {
  part: PartId;
  lane: number;
  notes: ScoreNote[];
}

/** Slurred notes (and grace notes with their main note) share a gesture. */
export function groupGestures(part: Part): Gesture[] {
  const out: Gesture[] = [];
  let current: Gesture | null = null;
  for (const n of part.notes) {
    if (n.lane !== 0) {
      out.push({ part: part.id, lane: n.lane, notes: [n] });
      continue;
    }
    const prev: ScoreNote | undefined = current?.notes[current.notes.length - 1];
    const joins =
      current && prev && n.restBefore < 0.01 &&
      (prev.marks.grace || (n.slurId !== null && n.slurId === prev.slurId));
    if (current && joins) current.notes.push(n);
    else out.push((current = { part: part.id, lane: 0, notes: [n] }));
  }
  return out.sort((a, b) => a.notes[0].start - b.notes[0].start || a.lane - b.lane);
}

const ROLE_DB: Record<Role, number> = { melody: 2.5, counter: 0.5, harmony: -2.5, bass: -1, rest: 0 };
const ROLE_VIBRATO: Record<Role, number> = { melody: 1, counter: 0.85, harmony: 0.55, bass: 0.6, rest: 0.5 };
const MAJOR_SCALE = [0, 2, 4, 5, 7, 9, 11];
const MINOR_SCALE = [0, 2, 3, 5, 7, 8, 11];
const SILENT = -72;

interface Timed {
  note: ScoreNote;
  t0: number;
  t1: number;
}

/**
 * An AI musician. Before playing it has studied the score (the Analysis);
 * while playing it plans each gesture moments before it sounds, reading the
 * conductor's time, the harmony, its role, and what the others are doing.
 */
export class Musician {
  readonly persona: Persona;
  readonly gestures: Gesture[];
  private readonly isStrings: boolean;

  constructor(
    readonly part: PartId,
    score: Score,
    private readonly analysis: Analysis,
    private readonly conductor: Conductor,
    private readonly ensemble: EnsembleState,
    private readonly rng: Rng,
    private readonly expressive: boolean,
  ) {
    this.persona = PERSONAS[part];
    this.gestures = groupGestures(score.parts[part]);
    this.isStrings = this.persona.instrument !== 'clarinet';
  }

  plan(g: Gesture): GesturePlan {
    const timed = this.timing(g);
    const roles = timed.map((t) => this.analysis.roleAt(this.part, t.note.start));
    const levels = timed.map((t, i) => this.level(g, t, i, roles[i]));
    const intents: (string | null)[] = levels.map((l) => l.intent);

    const notes: PlannedNote[] = timed.map((t, i) => {
      const h = this.analysis.harmonyOf(t.note);
      const tune = this.intonation(t, roles[i], h);
      const vib = this.vibratoFor(g, t, roles[i], levels[i].db, h);
      return {
        note: t.note,
        t0: t.t0,
        t1: t.t1,
        pitch: t.note.pitch + tune.cents / 100,
        db: levels[i].db,
        vibratoCents: vib.cents,
        role: roles[i],
        intent: intents[i] ?? tune.intent ?? vib.intent ?? this.fallbackIntent(g, t, i, roles[i]),
      };
    });

    const level = this.envelope(g, notes);
    const plan: GesturePlan = {
      part: this.part,
      lane: g.lane,
      start: notes[0].t0,
      end: level[level.length - 1].t,
      notes,
      pitch: this.pitchCurve(notes),
      level,
      vibrato: this.vibratoCurve(notes),
      noise: this.noiseCurve(g, notes),
      glide: this.persona.instrument === 'clarinet' ? 0.012 : this.persona.instrument === 'cello' ? 0.026 : 0.018,
    };
    this.ensemble.publish(plan);
    return plan;
  }

  // ------------------------------------------------------------------ time

  private timing(g: Gesture): Timed[] {
    const c = this.conductor;
    const role = this.analysis.roleAt(this.part, g.notes[0].start);
    // melody leads by a few ms; everyone scatters a little (Palmer 1996)
    const offset = this.expressive
      ? this.rng.gauss(0, this.persona.timingSd) / 1000 + (role === 'melody' ? -0.008 : 0)
      : 0;

    const out: Timed[] = [];
    let graces: ScoreNote[] = [];
    for (const n of g.notes) {
      if (n.marks.grace) {
        graces.push(n);
        continue;
      }
      let t0 = c.timeOf(n.start) + offset + (this.expressive ? this.rng.gauss(0, 0.002) : 0);
      if (graces.length) {
        // short grace notes on the beat, borrowing time from the main note
        const anchor = c.timeOf(graces[0].start) + offset;
        const each = Math.min(0.062, c.timeOf(graces[0].start + 0.125) - c.timeOf(graces[0].start));
        graces.forEach((gn, k) => out.push({ note: gn, t0: anchor + k * each, t1: 0 }));
        t0 = anchor + graces.length * each;
        graces = [];
      }
      out.push({ note: n, t0, t1: 0 });
    }

    for (let i = 0; i < out.length; i++) {
      const t = out[i];
      const next = out[i + 1];
      if (next) {
        // slurred: connected; portato (dots under a slur): separated in the bow
        const span = next.t0 - t.t0;
        t.t1 = t.note.marks.staccato && this.expressive ? t.t0 + span * 0.72 : next.t0;
        continue;
      }
      const nominal = c.timeOf(t.note.start + t.note.dur) + offset;
      t.t1 = t.t0 + Math.max(0.05, (nominal - t.t0) * this.lengthFactor(g, t.note));
    }
    return out;
  }

  /** How much of the written length the last note of a gesture sounds. */
  private lengthFactor(g: Gesture, n: ScoreNote): number {
    if (!this.expressive) return 0.92;
    if (n.marks.staccato) return 0.42;
    // a dissonance flows into its resolution even without a slur
    const h = this.analysis.harmonyOf(n);
    if (h.expressive && n.next && n.restAfter < 0.01 && Math.abs(n.next.pitch - n.pitch) <= 2) return 0.98;
    if (g.notes.length > 1) return n.restAfter >= 0.5 ? 0.92 : 0.8; // lift at the slur's end
    if (n.dur <= 0.5) {
      const repeated = n.prev?.pitch === n.pitch || n.next?.pitch === n.pitch;
      return repeated ? 0.55 : 0.68;
    }
    if (n.dur <= 1) return this.persona.detache;
    if (n.dur <= 2) return 0.9;
    return 0.95;
  }

  // ------------------------------------------------------------- dynamics

  private level(g: Gesture, t: Timed, i: number, role: Role): { db: number; intent: string | null } {
    const n = t.note;
    if (!this.expressive) return { db: n.markedDb + this.conductor.gestureDb, intent: null };
    const a = this.analysis;
    const h = a.harmonyOf(n);
    const chord = a.chordAt(n.start);
    const tess = a.tessitura[this.part];
    let intent: string | null = null;

    let db = n.markedDb + ROLE_DB[role];
    db += this.conductor.archDb(n.start) * (role === 'melody' ? 1 : 0.6);
    db += clamp((n.pitch - tess.median) * 0.12, -1.5, 2); // high = intense
    db += (chord.tension - 0.4) * 2.5;                    // harmonic charge

    const twoNoteSigh = g.notes.length === 2 && i === 0 && h.expressive && h.fn === 'chord-tone';
    if (h.expressive) {
      db += 1.8;
      intent = twoNoteSigh
        ? 'Sigh figure: weight on the first note, lift the second'
        : `Leaning into the ${h.fn} (${noteName(n.pitch)} against ${chord.label})`;
    } else if (h.isResolution) {
      db -= 1.8;
      intent = 'Resolving: softer, letting the tension go';
    } else if (h.fn === 'passing') {
      db -= 0.6;
    }
    if (h.leadingTone) db += 0.5;

    // metric weight for separate notes; slurs start full and end light
    if (g.notes.length === 1) db += (metricWeight(n.beatInBar) - 0.5) * 2;
    else if (i === 0) db += 0.8;
    else if (i === g.notes.length - 1 && g.notes.length > 2) db -= 1.2;

    // melodic contour inside a slur: the line swells as it climbs
    if (g.notes.length >= 3) {
      const mean = g.notes.reduce((s, x) => s + x.pitch, 0) / g.notes.length;
      db += clamp((n.pitch - mean) * 0.12, -2, 2);
    }

    const phrase = a.phraseAt(n.start);
    if (role === 'melody' && Math.abs(n.start - phrase.climax) < 0.01) {
      db += 1;
      intent ??= 'Phrase high point: fullest tone';
    }
    db += this.rng.gauss(0, 0.5);
    // an interpretation colours the written dynamic; it doesn't rewrite it
    db = clamp(db, n.markedDb - 6, n.markedDb + 6);
    // ...but a live conductor's larger or smaller gestures can ask for more
    db += this.conductor.gestureDb;

    // Listening: accompanying voices stay under the melody they can hear.
    const leader = a.leaderAt(n.start);
    if (role !== 'melody' && leader !== this.part) {
      const heard = this.ensemble.levelAt(leader, t.t0 + 0.01);
      const margin = role === 'bass' ? 1.5 : role === 'counter' ? 1.5 : 3;
      if (heard !== null && db > heard - margin) {
        const capped = heard - margin + (db - (heard - margin)) * 0.3;
        if (db - capped > 1) intent ??= `Listening: staying under ${PERSONAS[leader].name} (${PERSONAS[leader].role})`;
        db = capped;
      }
    }
    return { db, intent };
  }

  /** Breakpoints of the gesture's loudness, in dB, over performance time. */
  private envelope(g: Gesture, notes: PlannedNote[]): LevelPoint[] {
    const pts: LevelPoint[] = [];
    // a deliberate point (dip, release) replaces shape points at or after it
    const place = (t: number, db: number) => {
      while (pts.length > 2 && pts[pts.length - 1].t >= t - 0.004) pts.pop();
      pts.push({ t: Math.max(t, pts[pts.length - 1].t + 0.004), db });
    };
    const first = notes[0];
    const dyn = first.note.marks.dynamic;
    const accent = this.expressive && (dyn === 'sfp' || dyn === 'fp');
    const rise = this.attackTime(g, first);

    pts.push({ t: first.t0, db: SILENT });
    if (accent) {
      const spike = dyn === 'sfp' ? 11 : 9;
      pts.push({ t: first.t0 + 0.012, db: first.db + spike });
      pts.push({ t: first.t0 + 0.16, db: first.db - 1.5 });
      first.intent = `${dyn}: a bite on the attack, then hush to piano`;
    } else {
      pts.push({ t: first.t0 + rise, db: first.db + this.shape(g, notes, 0)[0][1] });
    }

    notes.forEach((n, i) => {
      const span = n.t1 - n.t0;
      for (const [frac, off] of this.shape(g, notes, i)) {
        const t = n.t0 + frac * span;
        if (t <= pts[pts.length - 1].t + 0.005) continue;
        pts.push({ t, db: n.db + off });
      }
      const next = notes[i + 1];
      if (!next) return;
      if (n.t1 < next.t0 - 0.01) {
        // portato: the bow lightens between notes without stopping
        place(n.t1, n.db - 3);
        place(next.t0 - 0.004, n.db - (this.isStrings ? 15 : 18));
      } else {
        // legato change of note: a slight dip as the finger moves
        const dip = this.isStrings ? 1.2 : 0.5;
        place(next.t0 - 0.012, Math.min(n.db, next.db) - dip);
      }
    });

    const last = notes[notes.length - 1];
    const release = this.releaseTime(last);
    const endDb = pts[pts.length - 1].db;
    if (last.t1 > pts[pts.length - 1].t + 0.005) pts.push({ t: last.t1, db: endDb });
    pts.push({ t: Math.max(last.t1, pts[pts.length - 1].t) + release, db: SILENT });
    return pts;
  }

  /** Micro-dynamics within a note: [fraction of note, dB offset] pairs. */
  private shape(g: Gesture, notes: PlannedNote[], i: number): [number, number][] {
    const n = notes[i];
    if (!this.expressive) return [[0, 0], [1, 0]];
    const span = n.t1 - n.t0;
    const h = this.analysis.harmonyOf(n.note);
    const next = notes[i + 1]?.note ?? n.note.next;
    if (span < 0.25) return [[0, 0], [1, 0]];

    if (h.expressive) return [[0, 1.2], [0.3, 0.8], [1, -2.5]]; // lean, then release
    if (n.note.marks.hairpin === 'cresc') return [[0, -1], [1, 2.5]];
    if (n.note.marks.hairpin === 'dim') return [[0, 1], [1, -2.5]];
    if (n.role === 'harmony' || n.role === 'bass') {
      if (span > 2.5) return [[0, -0.5], [0.4, 0.5], [1, -2.5]]; // long held chord: settle
      return [[0, -0.5], [0.5, 0.4], [1, -0.6]];
    }
    // melody: grow towards a higher next note in the same breath, otherwise
    // a messa di voce (swell and taper)
    if (next && next.pitch > n.note.pitch && g.notes.includes(next) && span < 1.2) {
      return [[0, -1.2], [0.7, 0.3], [1, 1.2]];
    }
    return [[0, -2.2], [0.45, 1.4], [1, -1.6]];
  }

  private attackTime(g: Gesture, n: PlannedNote): number {
    if (!this.expressive) return 0.02;
    const note = n.note;
    if (note.marks.staccato && g.notes.length === 1) return 0.009;
    const loud = note.markedDb > -14;
    const soft = n.role === 'harmony' || (note.dur >= 2 && !loud);
    if (this.persona.instrument === 'clarinet') return soft ? 0.06 : loud ? 0.02 : 0.035;
    if (loud && g.notes.length === 1) return 0.016;
    return soft ? 0.075 : 0.032;
  }

  private releaseTime(n: PlannedNote): number {
    const ring = n.note.restAfter >= 1 || !n.note.next;
    if (this.persona.instrument === 'clarinet') return ring ? 0.14 : 0.05;
    return ring ? 0.22 : 0.07;
  }

  // ------------------------------------------------------------- vibrato

  private vibratoFor(g: Gesture, t: Timed, role: Role, db: number, h: NoteHarmony): { cents: number; intent: string | null } {
    const p = this.persona;
    if (!this.expressive || p.vibratoDepth === 0 || t.note.marks.trill || t.note.marks.grace) return { cents: 0, intent: null };
    const seconds = t.t1 - t.t0;
    if (seconds < 0.16) return { cents: 0, intent: null };

    let intent: string | null = null;
    // An open string cannot vibrate; on long notes a player re-fingers it.
    if (OPEN_STRINGS[this.part].includes(t.note.pitch)) {
      if (seconds < 0.45) return { cents: 0, intent: null };
      if (role === 'melody' && seconds > 0.6) {
        intent = `${noteName(t.note.pitch)} stopped with the 4th finger, not the open string, so it can vibrate`;
      }
    }

    let depth = p.vibratoDepth * ROLE_VIBRATO[role];
    depth *= 0.7 + 0.5 * clamp((db + 30) / 24, 0, 1); // more intensity, more vibrato
    if (h.expressive) depth *= 1.3;
    if (h.isResolution) depth *= 0.85;
    const phrase = this.analysis.phraseAt(t.note.start);
    if (role === 'melody' && Math.abs(t.note.start - phrase.climax) < 0.01) depth *= 1.2;
    depth *= clamp((seconds - 0.16) / 0.5, 0.25, 1);
    if (g.notes.length > 4 && seconds < 0.3) depth *= 0.5;
    return { cents: depth, intent };
  }

  private vibratoCurve(notes: PlannedNote[]): VibratoPoint[] {
    const p = this.persona;
    if (p.vibratoDepth === 0) return [];
    const out: VibratoPoint[] = [];
    let current = 0;
    for (let i = 0; i < notes.length; i++) {
      const n = notes[i];
      let rate = p.vibratoRate + 0.5 * clamp((n.db + 26) / 20, 0, 1) + this.rng.gauss(0, 0.1);
      // entrain to the melody's vibrato speed so sustained chords don't beat
      const leader = this.analysis.leaderAt(n.note.start);
      if (leader !== this.part && n.role !== 'melody') {
        const heard = this.ensemble.vibratoRateAt(leader, n.t0);
        if (heard) rate = 0.5 * rate + 0.5 * heard;
      }
      const span = n.t1 - n.t0;
      const v = n.vibratoCents;
      if (v === 0) {
        out.push({ t: n.t0, cents: current * 0.5, rate });
        out.push({ t: n.t0 + Math.min(0.08, span), cents: 0, rate });
        current = 0;
        continue;
      }
      const continuing = current > 0;
      const delay = continuing ? 0.03 : this.rng.range(0.09, 0.16) * (this.analysis.harmonyOf(n.note).expressive ? 0.6 : 1);
      const bloom = clamp(span * 0.35, 0.12, 0.4);
      out.push({ t: n.t0, cents: continuing ? current * 0.8 : 0, rate });
      out.push({ t: n.t0 + Math.min(delay, span * 0.4), cents: v * 0.35, rate });
      out.push({ t: n.t0 + Math.min(delay + bloom, span * 0.8), cents: v, rate: rate + 0.15 });
      const fades = n.note.restAfter >= 0.5 || i === notes.length - 1;
      out.push({ t: n.t1 - Math.min(0.06, span * 0.1), cents: v * (fades ? 0.6 : 0.95), rate });
      current = v;
    }
    return out;
  }

  // -------------------------------------------------------------- pitch

  private intonation(t: Timed, role: Role, h: NoteHarmony): { cents: number; intent: string | null } {
    if (!this.expressive) return { cents: 0, intent: null };
    const n = t.note;
    const key = this.analysis.keyAt(n.start);
    const chord = this.analysis.chordAt(n.start);
    const scale = (key.mode === 'major' ? MAJOR_SCALE : MINOR_SCALE).map((s) => (s + key.tonic) % 12);
    let cents = this.rng.gauss(0, 1.5);
    let intent: string | null = null;

    if (role === 'melody' || role === 'counter') {
      // melodic intonation: tendency tones lean towards their goals
      const next = n.next && n.restAfter < 0.5 ? n.next : null;
      const step = next ? next.pitch - n.pitch : 0;
      if (h.leadingTone) {
        cents += 8;
        intent = `Leading tone ${noteName(n.pitch)} tuned high (+8¢), pulling to the tonic`;
      } else if (!scale.includes(pc(n.pitch)) && step === 1) {
        cents += 6;
      } else if (!scale.includes(pc(n.pitch)) && step === -1) {
        cents -= 5;
      }
    } else if (t.t1 - t.t0 > 0.35 && this.isStrings) {
      // harmonic intonation: sustained chord tones tuned towards just ratios
      const major = chord.quality === 'maj' || chord.quality === 'dom7';
      if (h.member === 'third') {
        cents += major ? -6 : 5;
        intent = `${major ? 'Major' : 'Minor'} third tuned ${major ? 'low (−6¢)' : 'high (+5¢)'} to ring with the chord`;
      } else if (h.member === 'seventh' && chord.quality === 'dom7') {
        cents -= 8;
        intent = 'Dominant seventh tuned low (−8¢), sinking toward its resolution';
      } else if (h.member === 'fifth') {
        cents += 1;
      }
    }
    return { cents, intent };
  }

  private pitchCurve(notes: PlannedNote[]): PitchPoint[] {
    const out: PitchPoint[] = [];
    notes.forEach((n, i) => {
      if (!n.note.marks.trill) {
        out.push({ t: n.t0, midi: n.pitch });
        return;
      }
      const end = notes[i + 1]?.t0 ?? n.t1;
      out.push(...this.trill(n, end));
    });
    return out;
  }

  /**
   * A Classical trill: it starts on the upper auxiliary (leaning on it a
   * little), accelerates, and settles on the main note before the written
   * termination.
   */
  private trill(n: PlannedNote, end: number): PitchPoint[] {
    const key = this.analysis.keyAt(n.note.start);
    const scale = (key.mode === 'major' ? MAJOR_SCALE : MINOR_SCALE).map((s) => (s + key.tonic) % 12);
    const upperStep = scale.includes(pc(n.note.pitch + 1)) ? 1 : 2;
    const upper = n.pitch + upperStep;
    const span = end - n.t0;
    n.intent = `Trill from the upper note (${noteName(n.note.pitch + upperStep)}), accelerating into the turn`;
    if (!this.expressive) return [{ t: n.t0, midi: n.pitch }];

    const out: PitchPoint[] = [];
    let t = n.t0;
    let onUpper = true;
    let k = 0;
    while (t < end - 0.1) {
      out.push({ t, midi: onUpper ? upper : n.pitch });
      const progress = (t - n.t0) / span;
      const rate = 9 + 5 * progress; // notes per second
      t += (1 / rate) * (k === 0 ? 1.6 : 1);
      onUpper = !onUpper;
      k++;
    }
    if (out[out.length - 1].midi !== n.pitch) out.push({ t: Math.min(t, end - 0.04), midi: n.pitch });
    return out;
  }

  private noiseCurve(g: Gesture, notes: PlannedNote[]): NoisePoint[] {
    const first = notes[0];
    const sharp = first.note.marks.staccato || (first.note.marks.dynamic ?? '').includes('f') || first.note.markedDb > -14;
    const strings = this.isStrings;
    const burst = !this.expressive ? 0.15 : strings ? (sharp ? 0.65 : 0.32) : sharp ? 0.4 : 0.22;
    const sustain = strings ? 0.06 : 0.045;
    const out: NoisePoint[] = [
      { t: first.t0, amount: burst },
      { t: first.t0 + (strings ? 0.07 : 0.04), amount: sustain },
    ];
    for (let i = 1; i < notes.length; i++) {
      const n = notes[i];
      if (notes[i - 1].t1 < n.t0 - 0.01) {
        // re-articulated under the slur
        out.push({ t: n.t0, amount: burst * 0.6 }, { t: n.t0 + 0.05, amount: sustain });
      } else if (strings && g.notes.length < 6) {
        out.push({ t: n.t0, amount: sustain * 1.8 }, { t: n.t0 + 0.04, amount: sustain });
      }
    }
    return out;
  }

  private fallbackIntent(g: Gesture, t: Timed, i: number, role: Role): string | null {
    if (!this.expressive) return null;
    const n = t.note;
    const phrase = this.analysis.phraseAt(n.start);
    if (n.marks.grace) return 'Grace note: quick and on the beat';
    if (n.marks.staccato && g.notes.length > 1) return 'Portato: notes separated within one bow';
    if (n.marks.hairpin === 'cresc') return 'Crescendo as marked, opening the tone';
    if (role === 'melody' && phrase.end - n.start <= 1.5 && phrase.end - n.start > 0 && phrase.closure >= 0.7) {
      return 'Relaxing into the cadence';
    }
    if (role === 'melody' && n.dur >= 1.5) return 'Messa di voce: swell and taper';
    if (g.notes.length === 1 && n.dur <= 0.5 && (n.prev?.pitch === n.pitch || n.next?.pitch === n.pitch)) {
      return 'Light, short détaché accompaniment';
    }
    if (role === 'melody' && i === 0 && g.notes.length > 2) return 'Shaping the slur: grow with the line, lighten the last note';
    return null;
  }
}
