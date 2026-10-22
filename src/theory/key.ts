import type { Score } from '../score/score';
import { fifthsDistance, pc, pcName } from './pitch';

export interface Key {
  tonic: number; // pitch class
  mode: 'major' | 'minor';
  name: string;
}

// Krumhansl & Kessler (1982) probe-tone key profiles.
const MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

function correlate(profile: number[], hist: number[], tonic: number): number {
  const n = 12;
  const mp = profile.reduce((a, b) => a + b, 0) / n;
  const mh = hist.reduce((a, b) => a + b, 0) / n;
  let num = 0, dp = 0, dh = 0;
  for (let i = 0; i < n; i++) {
    const p = profile[(i - tonic + 12) % 12] - mp;
    const h = hist[i] - mh;
    num += p * h;
    dp += p * p;
    dh += h * h;
  }
  return dh === 0 ? 0 : num / Math.sqrt(dp * dh);
}

const keyName = (tonic: number, mode: Key['mode']): string =>
  `${pcName(tonic)} ${mode}`;

/** Duration-weighted pitch-class histogram of a beat span (bass weighted up). */
function histogram(score: Score, from: number, to: number): number[] {
  const hist = new Array(12).fill(0);
  for (const n of score.notes) {
    if (n.marks.grace) continue;
    const overlap = Math.min(n.start + n.dur, to) - Math.max(n.start, from);
    if (overlap > 0) hist[pc(n.pitch)] += overlap * (n.part === 'cello' ? 1.5 : 1);
  }
  return hist;
}

/**
 * Local key for every bar. Each bar (with its neighbours) is correlated
 * against all 24 key profiles; a Viterbi pass then finds the most likely key
 * path, charging for every modulation (more for distant keys), so passing
 * chromaticism does not count as a change of key but a sustained move does.
 */
export function estimateKeys(score: Score, home: Key): Key[] {
  const bpb = score.beatsPerBar;
  const candidates: Key[] = [];
  for (let tonic = 0; tonic < 12; tonic++) {
    for (const mode of ['major', 'minor'] as const) candidates.push({ tonic, mode, name: keyName(tonic, mode) });
  }
  const fit = (bar: number) => {
    const hist = new Array(12).fill(0);
    for (let k = -1; k <= 1; k++) {
      histogram(score, (bar + k) * bpb, (bar + k + 1) * bpb).forEach((v, i) => (hist[i] += v * (k ? 0.5 : 1)));
    }
    return candidates.map((key) => correlate(key.mode === 'major' ? MAJOR : MINOR, hist, key.tonic));
  };
  const switchCost = (a: Key, b: Key) =>
    a === b ? 0 : 0.45 + 0.08 * fifthsDistance(a.tonic, b.tonic) + (a.mode !== b.mode ? 0.1 : 0);

  let score_ = candidates.map((k, i) => fit(0)[i] + (k.tonic === home.tonic && k.mode === home.mode ? 0.5 : 0));
  const back: number[][] = [];
  for (let bar = 1; bar < score.bars; bar++) {
    const f = fit(bar);
    const next: number[] = [];
    const ptr: number[] = [];
    candidates.forEach((to, j) => {
      let best = -Infinity, arg = 0;
      candidates.forEach((from, i) => {
        const v = score_[i] - switchCost(from, to);
        if (v > best) { best = v; arg = i; }
      });
      next.push(best + f[j]);
      ptr.push(arg);
    });
    back.push(ptr);
    score_ = next;
  }
  let j = score_.indexOf(Math.max(...score_));
  const path = [j];
  for (let bar = back.length - 1; bar >= 0; bar--) path.unshift((j = back[bar][j]));
  return path.map((i) => candidates[i]);
}

export const A_MAJOR: Key = { tonic: 9, mode: 'major', name: keyName(9, 'major') };
