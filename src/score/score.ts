import { parseMidi, type MidiFile } from './midi';

export type PartId = 'violin1' | 'violin2' | 'clarinet' | 'viola' | 'cello';

/** Stage order, left to right. */
export const PART_IDS: PartId[] = ['violin1', 'violin2', 'clarinet', 'viola', 'cello'];

export interface Marks {
  slurStart: boolean;
  slurEnd: boolean;
  staccato: boolean;
  trill: boolean;
  grace: boolean;
  /** Dynamic marking printed at this note, if any (p, f, sfp, fp, ...). */
  dynamic: string | null;
  hairpin: 'cresc' | 'dim' | 'end' | null;
}

export interface ScoreNote {
  id: number;
  part: PartId;
  /** 0 = the part's main line; 1+ = lower notes of a double stop. */
  lane: number;
  pitch: number;
  /** Onset and length in quarter-note beats from the start of bar 1. */
  start: number;
  dur: number;
  bar: number;
  beatInBar: number;
  marks: Marks;
  /** Dynamic level in force (written), e.g. 'p'. */
  dynamic: string;
  /** Written loudness in dB, including hairpins and fp/sfp settling. */
  markedDb: number;
  slurId: number | null;
  prev: ScoreNote | null;
  next: ScoreNote | null;
  /** Silence (beats) before and after this note in its lane. */
  restBefore: number;
  restAfter: number;
}

export interface Part {
  id: PartId;
  name: string;
  notes: ScoreNote[];
}

export interface Score {
  parts: Record<PartId, Part>;
  notes: ScoreNote[];
  beatsPerBar: number;
  totalBeats: number;
  bars: number;
  tempoQpm: number;
}

/** Written dynamics as nominal levels in dB below full scale. */
export const DYNAMIC_DB: Record<string, number> = {
  ppp: -34, pp: -29, p: -23, mp: -18, mf: -14, f: -9, ff: -5, fff: -2,
};

export async function loadScore(baseUrl: string): Promise<Score> {
  if (import.meta.env.VITE_MIDI_BUNDLE === 'json') return loadScoreBundle(baseUrl);
  const files = await Promise.all(
    PART_IDS.map(async (id) => {
      const res = await fetch(`${baseUrl}${id}.mid`);
      if (!res.ok) throw new Error(`Could not load ${id}.mid (${res.status})`);
      return [id, parseMidi(await res.arrayBuffer())] as const;
    }),
  );
  return buildScore(Object.fromEntries(files) as Record<PartId, MidiFile>);
}

/**
 * For hosts that don't serve .mid files: the same five MIDI files, base64
 * encoded in one JSON document (`midi.json`, written at build time).
 */
async function loadScoreBundle(baseUrl: string): Promise<Score> {
  const res = await fetch(`${baseUrl}midi.json`);
  if (!res.ok) throw new Error(`Could not load midi.json (${res.status})`);
  const bundle = (await res.json()) as Record<PartId, string>;
  const files = PART_IDS.map((id) => {
    const bytes = Uint8Array.from(atob(bundle[id]), (c) => c.charCodeAt(0));
    return [id, parseMidi(bytes.buffer)] as const;
  });
  return buildScore(Object.fromEntries(files) as Record<PartId, MidiFile>);
}

export function buildScore(files: Record<PartId, MidiFile>): Score {
  let nextId = 0;
  const parts = {} as Record<PartId, Part>;
  const first = files[PART_IDS[0]];
  const beatsPerBar = first.timeSignature[0] * (4 / first.timeSignature[1]);
  let totalBeats = 0;

  for (const id of PART_IDS) {
    const file = files[id];
    const track = file.tracks[0];
    const ppq = file.ppq;

    const marksAt = new Map<number, string[]>();
    for (const t of track.texts) {
      const list = marksAt.get(t.tick) ?? [];
      list.push(t.text);
      marksAt.set(t.tick, list);
    }

    // Group simultaneous onsets into chords; the highest note is lane 0.
    const byTick = new Map<number, typeof track.notes>();
    for (const n of track.notes) {
      const list = byTick.get(n.tick) ?? [];
      list.push(n);
      byTick.set(n.tick, list);
    }

    const notes: ScoreNote[] = [];
    const rawMarks = new Map<ScoreNote, string[]>();
    for (const [tick, chord] of [...byTick.entries()].sort((a, b) => a[0] - b[0])) {
      chord.sort((a, b) => b.pitch - a.pitch);
      const raw = marksAt.get(tick) ?? [];
      chord.forEach((m, lane) => {
        const start = tick / ppq;
        const note: ScoreNote = {
          id: nextId++,
          part: id,
          lane,
          pitch: m.pitch,
          start,
          dur: m.ticks / ppq,
          bar: Math.floor(start / beatsPerBar) + 1,
          beatInBar: start % beatsPerBar,
          marks: parseMarks(raw),
          dynamic: 'p',
          markedDb: DYNAMIC_DB.p,
          slurId: null,
          prev: null,
          next: null,
          restBefore: Infinity,
          restAfter: Infinity,
        };
        notes.push(note);
        rawMarks.set(note, raw);
        totalBeats = Math.max(totalBeats, start + note.dur);
      });
    }

    linkLanes(notes);
    assignSlurs(notes, rawMarks);
    assignDynamics(notes);
    parts[id] = { id, name: track.name || id, notes };
  }

  const bars = Math.ceil(totalBeats / beatsPerBar);
  return {
    parts,
    notes: PART_IDS.flatMap((id) => parts[id].notes),
    beatsPerBar,
    totalBeats: bars * beatsPerBar,
    bars,
    tempoQpm: first.tempoQpm,
  };
}

function parseMarks(raw: string[]): Marks {
  const marks: Marks = {
    slurStart: false, slurEnd: false, staccato: false, trill: false, grace: false,
    dynamic: null, hairpin: null,
  };
  for (const m of raw) {
    if (m === 'slur:start') marks.slurStart = true;
    else if (m === 'slur:end') marks.slurEnd = true;
    else if (m === 'art:staccato') marks.staccato = true;
    else if (m === 'orn:trill') marks.trill = true;
    else if (m === 'grace') marks.grace = true;
    else if (m.startsWith('dyn:')) marks.dynamic = m.slice(4);
    else if (m === 'hairpin:cresc') marks.hairpin = 'cresc';
    else if (m === 'hairpin:dim') marks.hairpin = 'dim';
    else if (m === 'hairpin:end') marks.hairpin = 'end';
  }
  return marks;
}

function linkLanes(notes: ScoreNote[]): void {
  const lanes = new Map<number, ScoreNote[]>();
  for (const n of notes) {
    const lane = lanes.get(n.lane) ?? [];
    lane.push(n);
    lanes.set(n.lane, lane);
  }
  for (const lane of lanes.values()) {
    lane.forEach((n, i) => {
      n.prev = lane[i - 1] ?? null;
      n.next = lane[i + 1] ?? null;
      if (n.prev) n.restBefore = Math.max(0, n.start - (n.prev.start + n.prev.dur));
      if (n.next) n.restAfter = Math.max(0, n.next.start - (n.start + n.dur));
    });
  }
}

/**
 * Slur groups on the main lane. A tied note that both ends one slur and
 * starts another (LilyPond `b4) ~ | b(`) stays in the old group and the new
 * group begins with the following note, i.e. the bow changes at the next note.
 */
function assignSlurs(notes: ScoreNote[], rawMarks: Map<ScoreNote, string[]>): void {
  let open: number | null = null;
  let counter = notes.length ? notes[0].id * 1000 : 0; // unique across parts
  for (const n of notes) {
    if (n.lane !== 0) continue;
    if (open !== null) n.slurId = open;
    for (const m of rawMarks.get(n) ?? []) {
      if (m === 'slur:end' && open !== null) {
        n.slurId = open;
        open = null;
      } else if (m === 'slur:start') {
        open = ++counter;
        if (n.slurId === null) n.slurId = open;
      }
    }
  }
}

function assignDynamics(notes: ScoreNote[]): void {
  let level = 'p';
  for (const n of notes) {
    const d = n.marks.dynamic;
    if (d && d in DYNAMIC_DB) level = d;
    // sfp / fp are accents that settle back to piano
    if (d === 'sfp' || d === 'fp') level = 'p';
    n.dynamic = level;
    n.markedDb = DYNAMIC_DB[level];
  }

  // Hairpins: interpolate between the start note and the hairpin end, aiming
  // for the next printed dynamic if it follows closely, otherwise ±5 dB.
  const main = notes.filter((n) => n.lane === 0);
  for (let i = 0; i < main.length; i++) {
    const kind = main[i].marks.hairpin;
    if (kind !== 'cresc' && kind !== 'dim') continue;
    let j = i + 1;
    while (j < main.length && main[j].marks.hairpin !== 'end' && !main[j].marks.dynamic) j++;
    const endNote = main[Math.min(j, main.length - 1)];
    const from = main[i].markedDb;
    const printed = endNote.marks.dynamic ? DYNAMIC_DB[endNote.marks.dynamic] : undefined;
    const to = printed ?? from + (kind === 'cresc' ? 5 : -5);
    const span = Math.max(endNote.start - main[i].start, 0.5);
    for (let k = i; k <= Math.min(j, main.length - 1); k++) {
      const x = (main[k].start - main[i].start) / span;
      main[k].markedDb = from + (to - from) * Math.min(1, x);
    }
    // the dynamic reached by a hairpin persists until the next marking
    for (let k = j + 1; k < main.length && !main[k].marks.dynamic; k++) {
      main[k].markedDb = to;
    }
  }
}
