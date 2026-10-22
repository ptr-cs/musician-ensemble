import { PART_IDS, type PartId, type Score, type ScoreNote } from '../score/score';
import { analyseHarmony, type Chord } from './harmony';
import { A_MAJOR, estimateKeys, type Key } from './key';
import { classifyNotes, type NoteHarmony } from './nct';
import { findPhrases, type Phrase } from './phrases';
import { assignRoles, type Role } from './roles';

/**
 * Everything the musicians learn from studying the score before they play:
 * local keys, harmony, the function of every note, who leads when, and the
 * phrase structure.
 */
export interface Analysis {
  chords: Chord[];
  noteHarmony: Map<number, NoteHarmony>;
  leader: PartId[];
  roles: Record<PartId, Role[]>;
  phrases: Phrase[];
  /** Median pitch of each part, the reference for "high = intense". */
  tessitura: Record<PartId, { median: number; low: number; high: number }>;
  keyAt(beat: number): Key;
  chordAt(beat: number): Chord;
  roleAt(part: PartId, beat: number): Role;
  leaderAt(beat: number): PartId;
  phraseAt(beat: number): Phrase;
  harmonyOf(note: ScoreNote): NoteHarmony;
}

export function analyse(score: Score): Analysis {
  const clampBeat = (b: number) => Math.max(0, Math.min(score.totalBeats - 1, Math.floor(b + 1e-6)));
  const { leader, roles } = assignRoles(score);

  const keys = estimateKeys(score, A_MAJOR);
  const keyAt = (beat: number) => keys[Math.min(keys.length - 1, Math.floor(clampBeat(beat) / score.beatsPerBar))];
  const chords = analyseHarmony(score, keyAt);
  const chordAt = (beat: number) => chords[clampBeat(beat)];
  const phrases = findPhrases(score, leader, chordAt);
  const noteHarmony = classifyNotes(score.notes, chordAt);

  const tessitura = {} as Analysis['tessitura'];
  for (const id of PART_IDS) {
    const pitches = score.parts[id].notes.map((n) => n.pitch).sort((a, b) => a - b);
    tessitura[id] = {
      median: pitches[Math.floor(pitches.length / 2)] ?? 60,
      low: pitches[0] ?? 48,
      high: pitches[pitches.length - 1] ?? 72,
    };
  }

  return {
    chords,
    noteHarmony,
    leader,
    roles,
    phrases,
    tessitura,
    keyAt,
    chordAt,
    roleAt: (part, beat) => roles[part][clampBeat(beat)],
    leaderAt: (beat) => leader[clampBeat(beat)],
    phraseAt: (beat) => phrases.find((p) => beat >= p.start && beat < p.end) ?? phrases[phrases.length - 1],
    harmonyOf: (note) => noteHarmony.get(note.id)!,
  };
}
