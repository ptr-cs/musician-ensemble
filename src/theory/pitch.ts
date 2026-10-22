import type { PartId } from '../score/score';

const NAMES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];

export const pc = (pitch: number): number => ((Math.round(pitch) % 12) + 12) % 12;

export const pcName = (pitchClass: number): string => NAMES[pc(pitchClass)];

export const noteName = (pitch: number): string =>
  `${NAMES[pc(pitch)]}${Math.floor(Math.round(pitch) / 12) - 1}`;

export const midiToHz = (pitch: number): number => 440 * 2 ** ((pitch - 69) / 12);

/** Number of steps around the circle of fifths between two pitch classes. */
export function fifthsDistance(a: number, b: number): number {
  const steps = (pc(b - a) * 7) % 12; // semitone interval -> fifths
  return Math.min(steps, 12 - steps);
}

/** Open strings of each string instrument (MIDI numbers). */
export const OPEN_STRINGS: Record<PartId, number[]> = {
  violin1: [55, 62, 69, 76],
  violin2: [55, 62, 69, 76],
  viola: [48, 55, 62, 69],
  cello: [36, 43, 50, 57],
  clarinet: [],
};

/**
 * Metric weight of a position in common time: the downbeat is strongest,
 * then beat 3, then beats 2 and 4, then off-beat subdivisions.
 */
export function metricWeight(beatInBar: number): number {
  const b = ((beatInBar % 4) + 4) % 4;
  if (Math.abs(b) < 1e-6) return 1;
  if (Math.abs(b - 2) < 1e-6) return 0.75;
  if (Math.abs(b - Math.round(b)) < 1e-6) return 0.5;
  if (Math.abs(b * 2 - Math.round(b * 2)) < 1e-6) return 0.3;
  return 0.15;
}
