import type { InstrumentKind } from '../performance/personas';
import { clamp } from '../performance/random';

export interface Resonance {
  type: 'peaking' | 'highshelf' | 'lowshelf';
  frequency: number;
  gain: number;
  Q?: number;
}

/**
 * Body resonances (main air and wood modes, the "bridge hill" around 2-3 kHz
 * for the violin family) and the high-frequency roll-off of each instrument.
 */
export const BODY: Record<InstrumentKind, Resonance[]> = {
  violin: [
    { type: 'peaking', frequency: 280, gain: 3, Q: 2.5 },
    { type: 'peaking', frequency: 460, gain: 4, Q: 3 },
    { type: 'peaking', frequency: 560, gain: 2.5, Q: 3 },
    { type: 'peaking', frequency: 1300, gain: -2.5, Q: 1.2 },
    { type: 'peaking', frequency: 2700, gain: 5, Q: 1.1 },
    { type: 'highshelf', frequency: 6500, gain: -8 },
  ],
  viola: [
    { type: 'peaking', frequency: 230, gain: 3.5, Q: 2.5 },
    { type: 'peaking', frequency: 390, gain: 4, Q: 3 },
    { type: 'peaking', frequency: 480, gain: 2, Q: 3 },
    { type: 'peaking', frequency: 1100, gain: -2.5, Q: 1.2 },
    { type: 'peaking', frequency: 2200, gain: 4, Q: 1.1 },
    { type: 'highshelf', frequency: 5000, gain: -9 },
  ],
  cello: [
    { type: 'peaking', frequency: 105, gain: 3, Q: 2 },
    { type: 'peaking', frequency: 190, gain: 4, Q: 2.5 },
    { type: 'peaking', frequency: 270, gain: 2, Q: 3 },
    { type: 'peaking', frequency: 650, gain: -2.5, Q: 1.2 },
    { type: 'peaking', frequency: 1500, gain: 3.5, Q: 1.2 },
    { type: 'highshelf', frequency: 3800, gain: -9 },
  ],
  clarinet: [
    { type: 'peaking', frequency: 420, gain: 1.5, Q: 1 },
    { type: 'peaking', frequency: 2600, gain: 2.5, Q: 1.2 },
    { type: 'highshelf', frequency: 6000, gain: -8 },
  ],
};

/** Per-instrument level trim (dB) so the written dynamics balance on stage. */
export const TRIM: Record<InstrumentKind, number> = {
  violin: 0, viola: 1.5, cello: 2, clarinet: -1,
};

/** Centre and width of the bow/breath noise band. */
export const NOISE_BAND: Record<InstrumentKind, { frequency: number; Q: number; level: number }> = {
  violin: { frequency: 3200, Q: 0.6, level: 0.32 },
  viola: { frequency: 2400, Q: 0.6, level: 0.32 },
  cello: { frequency: 1400, Q: 0.6, level: 0.3 },
  clarinet: { frequency: 3000, Q: 0.9, level: 0.22 },
};

/**
 * Harmonic amplitudes of the source waveform.
 * Bowed strings: a Helmholtz sawtooth (1/n) with the comb-filter dips of the
 * bowing point. Clarinet: a closed cylindrical bore, so odd harmonics dominate
 * in the low (chalumeau) register; even harmonics appear higher up, and
 * everything above the tone-hole cutoff falls away quickly.
 */
export function partials(kind: InstrumentKind, f0: number): number[] {
  if (kind === 'clarinet') {
    const count = Math.max(4, Math.min(30, Math.floor(11000 / f0)));
    const even = clamp((f0 - 220) / 500, 0.04, 0.45);
    const cutoff = 1500;
    return Array.from({ length: count }, (_, i) => {
      const k = i + 1;
      const base = (k % 2 ? 1 : even) / Math.pow(k, 0.8);
      const f = k * f0;
      return base * (f > cutoff ? Math.pow(cutoff / f, 2.2) : 1);
    });
  }
  const beta = kind === 'cello' ? 0.09 : kind === 'viola' ? 0.1 : 0.115; // bow distance from bridge
  const count = Math.max(6, Math.min(48, Math.floor(15000 / f0)));
  return Array.from({ length: count }, (_, i) => {
    const k = i + 1;
    return (0.3 + 0.7 * Math.abs(Math.sin(Math.PI * k * beta))) / k;
  });
}

/**
 * Low-pass cutoff for a given loudness: a louder bow stroke or a stronger
 * breath excites more upper harmonics, so timbre follows dynamics.
 */
export function cutoffFor(kind: InstrumentKind, f0: number, db: number, brightness: number): number {
  const b = clamp((db + 40) / 32, 0, 1) * (0.7 + 0.6 * brightness);
  if (kind === 'clarinet') return clamp(Math.max(f0 * 3, 700 + 4200 * Math.pow(b, 1.5)), 400, 9000);
  const harmonics = 3.5 + 24 * Math.pow(b, 1.3);
  return clamp(f0 * harmonics, 450, 14000);
}
