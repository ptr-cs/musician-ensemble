import type { Score } from '../score/score';
import type { Key } from './key';
import { fifthsDistance, pc, pcName } from './pitch';

export type Quality = 'maj' | 'min' | 'dim' | 'dom7' | 'min7' | 'hdim7' | 'dim7';
export type HarmonicFunction = 'T' | 'S' | 'D' | '?';

export interface Chord {
  root: number;
  quality: Quality;
  pcs: number[];
  bass: number;
  key: Key;
  roman: string;
  func: HarmonicFunction;
  /** Harmonic tension 0 (rest) .. 1 (maximal pull). */
  tension: number;
  label: string;
}

const TEMPLATES: Record<Quality, number[]> = {
  maj: [0, 4, 7],
  min: [0, 3, 7],
  dim: [0, 3, 6],
  dom7: [0, 4, 7, 10],
  min7: [0, 3, 7, 10],
  hdim7: [0, 3, 6, 10],
  dim7: [0, 3, 6, 9],
};

const SUFFIX: Record<Quality, string> = {
  maj: '', min: 'm', dim: '°', dom7: '7', min7: 'm7', hdim7: 'ø7', dim7: '°7',
};

/**
 * Identify one chord per beat by template matching a duration-weighted
 * pitch-class set (bass weighted up), with harmonic-rhythm inertia.
 */
export function analyseHarmony(score: Score, keyAtBeat: (beat: number) => Key): Chord[] {
  const chords: Chord[] = [];
  let previous: Chord | null = null;

  for (let beat = 0; beat < score.totalBeats; beat++) {
    const weights = new Array(12).fill(0);
    let bass = Infinity;
    for (const n of score.notes) {
      if (n.marks.grace) continue;
      const overlap = Math.min(n.start + n.dur, beat + 1) - Math.max(n.start, beat);
      if (overlap <= 0) continue;
      // notes that begin inside the beat count more than ones held over
      const onset = n.start >= beat ? 1.15 : 1;
      weights[pc(n.pitch)] += overlap * onset;
      if (n.pitch < bass) bass = n.pitch;
    }
    const key = keyAtBeat(beat);
    const total = weights.reduce((a, b) => a + b, 0);
    if (total === 0 || !Number.isFinite(bass)) {
      if (previous) chords.push({ ...previous, key });
      else chords.push(describe(key.tonic, 'maj', key.tonic, key));
      continue;
    }
    weights[pc(bass)] += 0.5 * total / 4;

    let best: { root: number; quality: Quality; score: number } | null = null;
    for (let root = 0; root < 12; root++) {
      for (const quality of Object.keys(TEMPLATES) as Quality[]) {
        const tones = TEMPLATES[quality].map((i) => (root + i) % 12);
        let s = 0;
        for (let p = 0; p < 12; p++) s += tones.includes(p) ? weights[p] : -0.7 * weights[p];
        s /= total;
        if (pc(bass) === root) s += 0.18;
        if (tones.length === 4) s -= 0.08; // prefer the simpler explanation
        if (!tones.every((t) => weights[t] > 0)) s -= 0.12; // incomplete chord
        if (previous && previous.root === root && previous.quality === quality) s += beat % 2 ? 0.12 : 0.05;
        if (!best || s > best.score) best = { root, quality, score: s };
      }
    }
    const chord = describe(best!.root, best!.quality, pc(bass), key);
    chords.push(chord);
    previous = chord;
  }
  return chords;
}

function describe(root: number, quality: Quality, bass: number, key: Key): Chord {
  const { roman, func, base } = romanNumeral(root, quality, key);
  const away = fifthsDistance(key.tonic, 9) * 0.05; // distance from home key, A
  const seventh = quality === 'dom7' || quality === 'dim7' ? 0.08 : 0;
  const inversion = pc(bass) !== root ? 0.05 : 0;
  return {
    root,
    quality,
    pcs: TEMPLATES[quality].map((i) => (root + i) % 12),
    bass,
    key,
    roman,
    func,
    tension: Math.min(1, base + away + seventh + inversion),
    label: `${pcName(root)}${SUFFIX[quality]}`,
  };
}

const MAJOR_DEGREES: Record<number, string> = { 0: 'I', 2: 'ii', 4: 'iii', 5: 'IV', 7: 'V', 9: 'vi', 11: 'vii' };
const MINOR_DEGREES: Record<number, string> = { 0: 'i', 2: 'ii', 3: 'III', 5: 'iv', 7: 'V', 8: 'VI', 10: 'VII', 11: 'vii' };

function romanNumeral(root: number, quality: Quality, key: Key): { roman: string; func: HarmonicFunction; base: number } {
  const degree = pc(root - key.tonic);
  const degrees = key.mode === 'major' ? MAJOR_DEGREES : MINOR_DEGREES;
  const majorish = quality === 'maj' || quality === 'dom7';
  const sev = quality === 'dom7' || quality === 'min7' ? '7' : quality === 'dim7' ? '°7' : quality === 'hdim7' ? 'ø7' : quality === 'dim' ? '°' : '';

  let numeral = degrees[degree];
  if (numeral) {
    numeral = majorish ? numeral.toUpperCase() : numeral.toLowerCase();
    const func: HarmonicFunction =
      degree === 0 || degree === 9 || degree === 4 || degree === 3 || degree === 8 ? 'T'
      : degree === 5 || degree === 2 ? 'S'
      : 'D';
    const base: Record<HarmonicFunction, number> = { T: 0.12, S: 0.4, D: 0.62, '?': 0.5 };
    let t = base[func];
    if (degree === 9 || degree === 8) t += 0.12;
    if (degree === 4) t += 0.2;
    if (degree === 11 || quality === 'dim7') t = 0.82;
    // a major chord on a minor degree is an applied dominant, handled below
    if (!(majorish && (degree === 2 || degree === 4 || degree === 9))) {
      return { roman: numeral + sev, func, base: t };
    }
  }
  // applied (secondary) dominants and leading-tone chords
  const target = pc(degree + 5);
  if (majorish && degrees[target]) {
    return { roman: `V${quality === 'dom7' ? '7' : ''}/${degrees[target]}`, func: 'D', base: 0.72 };
  }
  const ltTarget = pc(degree + 1);
  if ((quality === 'dim' || quality === 'dim7' || quality === 'hdim7') && degrees[ltTarget]) {
    return { roman: `vii${sev}/${degrees[ltTarget]}`, func: 'D', base: 0.8 };
  }
  return { roman: `${pcName(root)}${SUFFIX[quality]}`, func: '?', base: 0.6 };
}
