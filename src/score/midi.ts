/**
 * Minimal Standard MIDI File reader. Unlike general-purpose MIDI libraries it
 * keeps text meta-events, which is where tools/ly2midi.py stores the score's
 * performance markings (slurs, staccato, dynamics, trills, grace notes).
 */

export interface MidiNote {
  tick: number;
  ticks: number;
  pitch: number;
  velocity: number;
}

export interface MidiText {
  tick: number;
  text: string;
}

export interface MidiTrack {
  name: string;
  notes: MidiNote[];
  texts: MidiText[];
}

export interface MidiFile {
  ppq: number;
  tempoQpm: number;
  timeSignature: [number, number];
  tracks: MidiTrack[];
}

class Reader {
  pos = 0;
  constructor(private view: DataView) {}

  get done(): boolean {
    return this.pos >= this.view.byteLength;
  }
  u8(): number {
    return this.view.getUint8(this.pos++);
  }
  u16(): number {
    const v = this.view.getUint16(this.pos);
    this.pos += 2;
    return v;
  }
  u32(): number {
    const v = this.view.getUint32(this.pos);
    this.pos += 4;
    return v;
  }
  ascii(length: number): string {
    let s = '';
    for (let i = 0; i < length; i++) s += String.fromCharCode(this.u8());
    return s;
  }
  vlq(): number {
    let value = 0;
    for (;;) {
      const b = this.u8();
      value = (value << 7) | (b & 0x7f);
      if (!(b & 0x80)) return value;
    }
  }
}

export function parseMidi(buffer: ArrayBuffer): MidiFile {
  const r = new Reader(new DataView(buffer));
  if (r.ascii(4) !== 'MThd') throw new Error('Not a MIDI file');
  const headerLength = r.u32();
  r.u16(); // format
  const trackCount = r.u16();
  const division = r.u16();
  r.pos += headerLength - 6;
  if (division & 0x8000) throw new Error('SMPTE time division is not supported');

  const file: MidiFile = { ppq: division, tempoQpm: 120, timeSignature: [4, 4], tracks: [] };

  for (let t = 0; t < trackCount && !r.done; t++) {
    const id = r.ascii(4);
    const length = r.u32();
    const end = r.pos + length;
    if (id !== 'MTrk') {
      r.pos = end;
      continue;
    }
    const track: MidiTrack = { name: '', notes: [], texts: [] };
    const sounding = new Map<number, { tick: number; velocity: number }>();
    let tick = 0;
    let status = 0;

    while (r.pos < end) {
      tick += r.vlq();
      const byte = r.u8();
      if (byte === 0xff) {
        const type = r.u8();
        const len = r.vlq();
        const start = r.pos;
        if (type === 0x01 || type === 0x03) {
          const text = r.ascii(len);
          if (type === 0x03) track.name = text;
          else track.texts.push({ tick, text });
        } else if (type === 0x51) {
          const us = (r.u8() << 16) | (r.u8() << 8) | r.u8();
          file.tempoQpm = 60_000_000 / us;
        } else if (type === 0x58) {
          file.timeSignature = [r.u8(), 2 ** r.u8()];
        }
        r.pos = start + len;
        continue;
      }
      if (byte === 0xf0 || byte === 0xf7) {
        r.pos += r.vlq();
        continue;
      }
      // channel message, honouring running status
      let data1: number;
      if (byte & 0x80) {
        status = byte;
        data1 = r.u8();
      } else {
        data1 = byte;
      }
      const kind = status & 0xf0;
      const twoBytes = kind !== 0xc0 && kind !== 0xd0;
      const data2 = twoBytes ? r.u8() : 0;

      if (kind === 0x90 && data2 > 0) {
        sounding.set(data1, { tick, velocity: data2 });
      } else if (kind === 0x80 || (kind === 0x90 && data2 === 0)) {
        const on = sounding.get(data1);
        if (on) {
          track.notes.push({ tick: on.tick, ticks: tick - on.tick, pitch: data1, velocity: on.velocity });
          sounding.delete(data1);
        }
      }
    }
    track.notes.sort((a, b) => a.tick - b.tick || b.pitch - a.pitch);
    file.tracks.push(track);
    r.pos = end;
  }
  return file;
}
