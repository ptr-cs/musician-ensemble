import type { PartId, ScoreNote } from '../score/score';
import type { Role } from '../theory/roles';

/** A note as the musician decided to play it. Times are performance seconds. */
export interface PlannedNote {
  note: ScoreNote;
  t0: number;
  t1: number;
  /** Fractional MIDI pitch including expressive intonation. */
  pitch: number;
  db: number;
  vibratoCents: number;
  role: Role;
  /** Why the musician shaped the note this way (shown on stage). */
  intent: string | null;
}

export interface PitchPoint { t: number; midi: number }
export interface LevelPoint { t: number; db: number }
export interface VibratoPoint { t: number; cents: number; rate: number }
export interface NoisePoint { t: number; amount: number }

/**
 * One continuous sound: a bow stroke or a breath. A slur becomes a single
 * gesture whose pitch changes underneath one envelope, as on a real instrument.
 */
export interface GesturePlan {
  part: PartId;
  lane: number;
  start: number;
  end: number;
  notes: PlannedNote[];
  pitch: PitchPoint[];
  level: LevelPoint[];
  vibrato: VibratoPoint[];
  noise: NoisePoint[];
  /** Seconds a slurred pitch change takes (finger or key motion). */
  glide: number;
}
