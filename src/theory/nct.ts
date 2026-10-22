import type { ScoreNote } from '../score/score';
import type { Chord } from './harmony';
import { metricWeight, pc } from './pitch';

export type NoteFunction =
  | 'chord-tone'
  | 'passing'
  | 'neighbor'
  | 'appoggiatura'
  | 'suspension'
  | 'anticipation'
  | 'escape'
  | 'other-nct';

export interface NoteHarmony {
  fn: NoteFunction;
  /** Chord member: 'root' | 'third' | 'fifth' | 'seventh' when a chord tone. */
  member: 'root' | 'third' | 'fifth' | 'seventh' | null;
  /** Resolves a dissonance from the previous note (leans away from it). */
  isResolution: boolean;
  /** Leading tone of the local key moving up to the tonic. */
  leadingTone: boolean;
  /** Dissonance the player should lean on (accented non-chord tone). */
  expressive: boolean;
}

const isStep = (a: number, b: number) => {
  const d = Math.abs(a - b);
  return d === 1 || d === 2;
};

/**
 * Classify every note against the chord sounding at its onset, using the
 * melodic approach and departure as in a counterpoint textbook.
 */
export function classifyNotes(notes: ScoreNote[], chordAt: (beat: number) => Chord): Map<number, NoteHarmony> {
  const out = new Map<number, NoteHarmony>();
  for (const n of notes) {
    const chord = chordAt(n.start);
    const p = pc(n.pitch);
    const idx = chord.pcs.indexOf(p);
    const member = idx < 0 ? null : (['root', 'third', 'fifth', 'seventh'] as const)[idx];
    const prev = n.prev && n.restBefore < 0.5 ? n.prev : null;
    const next = n.next && n.restAfter < 0.5 ? n.next : null;
    const strong = metricWeight(n.beatInBar) >= 0.5 && n.dur >= 0.5;

    let fn: NoteFunction = 'chord-tone';
    if (member === null && !n.marks.grace) {
      const stepIn = prev ? isStep(prev.pitch, n.pitch) : false;
      const stepOut = next ? isStep(n.pitch, next.pitch) : false;
      const dirIn = prev ? Math.sign(n.pitch - prev.pitch) : 0;
      const dirOut = next ? Math.sign(next.pitch - n.pitch) : 0;
      if (prev && prev.pitch === n.pitch && strong && stepOut && dirOut < 0) fn = 'suspension';
      else if (strong && stepOut) fn = 'appoggiatura';
      else if (stepIn && stepOut && dirIn === dirOut) fn = 'passing';
      else if (stepIn && stepOut) fn = 'neighbor';
      else if (next && next.pitch === n.pitch) fn = 'anticipation';
      else if (stepIn && next && !stepOut) fn = 'escape';
      else fn = 'other-nct';
    }

    const key = chord.key;
    const leadingTone =
      p === pc(key.tonic - 1) && !!next && pc(next.pitch) === key.tonic && next.pitch > n.pitch;

    out.set(n.id, {
      fn,
      member,
      isResolution: false,
      leadingTone,
      expressive: fn === 'appoggiatura' || fn === 'suspension',
    });
  }

  // A note that follows an accented dissonance by step is its resolution.
  for (const n of notes) {
    const h = out.get(n.id)!;
    if (h.expressive && n.next && isStep(n.pitch, n.next.pitch)) {
      const r = out.get(n.next.id);
      if (r) r.isResolution = true;
    }
  }

  // Two-note slurs whose first note is metrically stronger are "sighs":
  // Classical practice leans on the first and lifts the second, so treat the
  // first like an appoggiatura even when it is consonant.
  for (const n of notes) {
    const next = n.next;
    if (!next || n.slurId === null || next.slurId !== n.slurId) continue;
    const prevInSlur = n.prev && n.prev.slurId === n.slurId;
    const nextNextInSlur = next.next && next.next.slurId === n.slurId;
    if (!prevInSlur && !nextNextInSlur && metricWeight(n.beatInBar) > metricWeight(next.beatInBar)) {
      out.get(n.id)!.expressive = true;
      out.get(next.id)!.isResolution = true;
    }
  }
  return out;
}
