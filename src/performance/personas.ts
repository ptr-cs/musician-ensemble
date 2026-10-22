import type { PartId } from '../score/score';

export type InstrumentKind = 'violin' | 'viola' | 'cello' | 'clarinet';

/** The individual habits of each AI musician. */
export interface Persona {
  part: PartId;
  name: string;
  role: string;
  instrument: InstrumentKind;
  style: string;
  /** Vibrato width (cents, half peak-to-peak) and speed (Hz) at full intensity. */
  vibratoDepth: number;
  vibratoRate: number;
  /** Onset timing scatter (ms, one standard deviation). */
  timingSd: number;
  /** Fraction of the written length an unslurred note is held. */
  detache: number;
  /** Tone colour, 0 dark .. 1 bright. */
  brightness: number;
  /** Stage position, -1 (left) .. 1 (right). */
  pan: number;
}

export const PERSONAS: Record<PartId, Persona> = {
  violin1: {
    part: 'violin1',
    name: 'Aurelia',
    role: 'Violin I',
    instrument: 'violin',
    style: 'Singing line, narrow Classical vibrato that blooms on long notes',
    vibratoDepth: 15,
    vibratoRate: 5.9,
    timingSd: 5,
    detache: 0.84,
    brightness: 0.62,
    pan: -0.62,
  },
  violin2: {
    part: 'violin2',
    name: 'Matteo',
    role: 'Violin II',
    instrument: 'violin',
    style: 'Attentive inner voice, matches the leader’s vibrato speed',
    vibratoDepth: 12,
    vibratoRate: 5.6,
    timingSd: 6,
    detache: 0.8,
    brightness: 0.52,
    pan: -0.3,
  },
  clarinet: {
    part: 'clarinet',
    name: 'Anton',
    role: 'Clarinet in A',
    instrument: 'clarinet',
    style: 'Named for Anton Stadler, for whom Mozart wrote the quintet; no vibrato, shapes with breath',
    vibratoDepth: 0,
    vibratoRate: 0,
    timingSd: 5,
    detache: 0.82,
    brightness: 0.45,
    pan: 0.02,
  },
  viola: {
    part: 'viola',
    name: 'Ines',
    role: 'Viola',
    instrument: 'viola',
    style: 'Warm, dark-toned, blends into the harmony',
    vibratoDepth: 13,
    vibratoRate: 5.4,
    timingSd: 6,
    detache: 0.8,
    brightness: 0.4,
    pan: 0.32,
  },
  cello: {
    part: 'cello',
    name: 'Benedikt',
    role: 'Violoncello',
    instrument: 'cello',
    style: 'Anchors the harmony, steps forward whenever the melody passes to the bass',
    vibratoDepth: 14,
    vibratoRate: 5.2,
    timingSd: 5,
    detache: 0.86,
    brightness: 0.45,
    pan: 0.62,
  },
};
