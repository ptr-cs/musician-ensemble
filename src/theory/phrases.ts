import { PART_IDS, type PartId, type Score } from '../score/score';
import type { Chord } from './harmony';
import { metricWeight, pc } from './pitch';

export interface Phrase {
  index: number;
  /** Beat span; `end` is the arrival (cadence) beat. */
  start: number;
  end: number;
  /** Beat of the expressive high point the phrase is shaped towards. */
  climax: number;
  leader: PartId;
  cadence: 'authentic' | 'half' | 'open';
  /** How strongly the arrival closes the phrase, 0..1. */
  closure: number;
}

/**
 * Segment the excerpt into phrases. A boundary is either a cadence (at least
 * three parts land on a short note followed by silence) or a hand-off (the
 * melodic leader finishes and another instrument takes over).
 */
export function findPhrases(score: Score, leader: PartId[], chordAt: (beat: number) => Chord): Phrase[] {
  const evidence = new Map<number, number>();
  const add = (beat: number, w: number) => evidence.set(beat, (evidence.get(beat) ?? 0) + w);

  for (let b = 1; b < score.totalBeats; b++) {
    let landings = 0;
    for (const id of PART_IDS) {
      const n = score.parts[id].notes.find((x) => x.lane === 0 && !x.marks.grace && x.start === b);
      if (n && n.dur <= 2 && n.restAfter >= 1) landings++;
    }
    // a cadence needs the melody to come to rest too, not just the accompaniment
    const lead = leader[b - 1];
    const leadNote = score.parts[lead].notes.find((x) => x.lane === 0 && x.start <= b && x.start + x.dur > b);
    const leadRests = !leadNote || (leadNote.start === b && leadNote.restAfter >= 0.5);
    if (landings >= 3 && leadRests) add(b, landings);

    const prevLead = leader[b - 1];
    const n = score.parts[prevLead].notes.find(
      (x) => x.lane === 0 && x.start <= b && x.start + x.dur > b - 0.01 && x.start + x.dur <= b + 2,
    );
    if (n && n.restAfter >= 1 && leader[Math.min(b + 2, leader.length - 1)] !== prevLead) {
      add(Math.round(n.start), 2);
    }
  }

  // Keep the strongest evidence within any 4-beat neighbourhood.
  const candidates = [...evidence.entries()]
    .filter(([b]) => b > 2 && b < score.totalBeats - 6)
    .sort((a, b) => b[1] - a[1]);
  const boundaries: number[] = [];
  for (const [b] of candidates) {
    if (boundaries.every((x) => Math.abs(x - b) >= 4)) boundaries.push(b);
  }
  boundaries.sort((a, b) => a - b);
  boundaries.push(score.totalBeats);

  const phrases: Phrase[] = [];
  let start = 0;
  boundaries.forEach((end, index) => {
    const span = leader.slice(start, end);
    const lead = mode(span) ?? 'violin1';
    phrases.push({
      index,
      start,
      end,
      climax: findClimax(score, lead, start, end, chordAt),
      leader: lead,
      ...cadenceAt(end, chordAt),
    });
    start = end;
  });
  return phrases;
}

function mode<T>(items: T[]): T | undefined {
  const counts = new Map<T, number>();
  for (const i of items) counts.set(i, (counts.get(i) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
}

function findClimax(score: Score, lead: PartId, start: number, end: number, chordAt: (b: number) => Chord): number {
  const notes = score.parts[lead].notes.filter((n) => n.lane === 0 && n.start >= start && n.start < end && !n.marks.grace);
  if (!notes.length) return start + (end - start) * 0.6;
  const lo = Math.min(...notes.map((n) => n.pitch));
  const hi = Math.max(...notes.map((n) => n.pitch));
  let best = notes[0];
  let bestScore = -Infinity;
  for (const n of notes) {
    const x = (n.start - start) / Math.max(1, end - start);
    const s =
      (n.pitch - lo) / Math.max(1, hi - lo) +
      0.5 * chordAt(n.start).tension +
      0.2 * metricWeight(n.beatInBar) +
      0.15 * Math.min(n.dur, 2) -
      (x < 0.25 || x > 0.92 ? 0.6 : 0); // climaxes sit inside the phrase
    if (s > bestScore) {
      bestScore = s;
      best = n;
    }
  }
  return best.start;
}

function cadenceAt(beat: number, chordAt: (b: number) => Chord): Pick<Phrase, 'cadence' | 'closure'> {
  const arrival = chordAt(beat);
  const before = [chordAt(beat - 1), chordAt(beat - 2)];
  const tonicArrival = arrival.root === arrival.key.tonic && arrival.func === 'T';
  if (tonicArrival && before.some((c) => c.func === 'D')) return { cadence: 'authentic', closure: 1 };
  if (arrival.func === 'D' && pc(arrival.root - arrival.key.tonic) === 7) return { cadence: 'half', closure: 0.7 };
  return { cadence: 'open', closure: 0.45 };
}
