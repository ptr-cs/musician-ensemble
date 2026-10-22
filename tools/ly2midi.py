#!/usr/bin/env python3
"""
Convert the first two pages (bars 1-39) of Mozart's Clarinet Quintet KV 581,
first movement, into one Standard MIDI File per instrument.

Source: the Mutopia Project LilyPond engraving (Mutopia #337) from which
IMSLP01455-K581-score-a4.pdf was produced. The relevant LilyPond part files are
vendored in tools/ly-source/. Only the subset of LilyPond syntax used in these
bars is supported (relative mode, chords, ties, slurs, grace notes, dynamics,
hairpins, staccato, trills).

Output (concert pitch, PPQ 480, 4/4, A major):
  public/midi/{clarinet,violin1,violin2,viola,cello}.mid

Besides notes, every file carries the score's performance markings as MIDI
text meta-events stamped at the onset tick of the note they belong to:
  slur:start  slur:end  art:staccato  orn:trill  grace
  dyn:<p|pp|f|sfp|fp|...>  hairpin:cresc  hairpin:dim  hairpin:end
The web app's musicians read these markings to shape their interpretation.

Usage: python3 tools/ly2midi.py [--dump]
"""
from __future__ import annotations

import os
import re
import struct
import sys
from dataclasses import dataclass, field
from fractions import Fraction

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "tools", "ly-source")
OUT = os.path.join(ROOT, "public", "midi")

LAST_BAR = 39  # bars 1-39 are the first two pages of the PDF
PPQ = 480
TEMPO_QPM = 120
GRACE_TICKS = PPQ // 8  # a 32nd-note grace, played on the beat

PARTS = [
    # file, variable, output name, track name, GM program, transposition (semitones)
    ("clarinet-i.ly", "clarinetFirstMov", "clarinet", "Clarinet in A", 71, -3),
    ("violin1-i.ly", "violinIFirstMov", "violin1", "Violin I", 40, 0),
    ("violin2-i.ly", "violinIIFirstMov", "violin2", "Violin II", 40, 0),
    ("viola-i.ly", "violaFirstMov", "viola", "Viola", 41, 0),
    ("cello-i.ly", "celloFirstMov", "cello", "Violoncello", 42, 0),
]

STEP_SEMITONES = [0, 2, 4, 5, 7, 9, 11]
STEP_OF = {n: i for i, n in enumerate("cdefgab")}
DYNAMICS = {"ppp", "pp", "p", "mp", "mf", "f", "ff", "fff", "sf", "sfp", "fp", "sfz"}
VELOCITY = {"ppp": 24, "pp": 36, "p": 50, "mp": 62, "mf": 74, "f": 90, "ff": 104,
            "fff": 116, "sf": 100, "sfz": 100, "sfp": 96, "fp": 92}
AFTER_ACCENT = {"sfp": "p", "fp": "p", "sf": None, "sfz": None}


# --------------------------------------------------------------------------
# Pre-processing: reduce the LilyPond file to plain music tokens
# --------------------------------------------------------------------------

def strip_balanced(text: str, opener: str, open_ch: str, close_ch: str) -> str:
    """Remove every `opener` followed by a balanced open_ch...close_ch group."""
    out, i = [], 0
    while True:
        j = text.find(opener, i)
        if j < 0:
            out.append(text[i:])
            return "".join(out)
        out.append(text[i:j])
        k = text.index(open_ch, j)
        depth = 0
        while True:
            if text[k] == open_ch:
                depth += 1
            elif text[k] == close_ch:
                depth -= 1
                if depth == 0:
                    break
            k += 1
        i = k + 1


def extract_music(path: str, variable: str) -> tuple[str, str]:
    text = open(path, encoding="utf-8").read()
    text = re.sub(r"%\{.*?%\}", " ", text, flags=re.S)
    text = re.sub(r"%[^\n]*", " ", text)
    text = strip_balanced(text, "#(", "(", ")")
    m = re.search(variable + r"\s*=\s*\\relative\s+([a-g](?:is|es)*[',]*)\s*\{", text)
    if not m:
        raise SystemExit(f"{variable} not found in {path}")
    start = k = m.end() - 1
    depth = 0
    while True:
        if text[k] == "{":
            depth += 1
        elif text[k] == "}":
            depth -= 1
            if depth == 0:
                break
        k += 1
    body = text[start + 1:k]
    body = re.sub(r"[\^_-]?\s*\\markup\s*", r"\\markup", body)
    body = strip_balanced(body, "\\markup", "{", "}")
    body = re.sub(r"\\override\s+\S+\s+#'\S+\s*=\s*#\S+", " ", body)
    body = re.sub(r"\\revert\s+\S+\s+#'\S+", " ", body)
    body = re.sub(r"\\set\s+\S+\s*=", " ", body)
    body = re.sub(r"\\key\s+\w+\s+\\\w+", " ", body)
    body = re.sub(r"\\clef\s+\w+", " ", body)
    body = re.sub(r"\\repeat\s+volta\s+\d+", " ", body)
    return m.group(1), body


TOKEN = re.compile(r"""
    (?P<art>[-^_][.>^+!_|])                                     # articulation
  | (?P<cmd>\\[<>!]|\\[a-zA-Z]+)                                # command / dynamic
  | (?P<note>(?:eses|es|ases|as|[a-g](?:isis|eses|is|es)?)(?![a-z]))
        !?(?P<oct>[',]*)(?P<dur>\d+)?(?P<dots>\.*)
  | (?P<rest>[rR])(?P<rdur>\d+)?(?P<rdots>\.*)(?P<mul>\*\d+)?
  | (?P<chordend>>)(?P<cdur>\d+)?(?P<cdots>\.*)
  | (?P<sym>[{}<()~\[\]|])
  | (?P<ws>\s+)
""", re.X)


def tokenize(body: str):
    pos = 0
    while pos < len(body):
        m = TOKEN.match(body, pos)
        if not m:
            raise SystemExit(f"cannot tokenize near: {body[pos:pos + 40]!r}")
        pos = m.end()
        if m.lastgroup != "ws":
            yield m


# --------------------------------------------------------------------------
# Pitch arithmetic
# --------------------------------------------------------------------------

def parse_pitch(name: str) -> tuple[int, int]:
    """(diatonic step 0-6, chromatic alteration) for a Dutch note name."""
    if name in ("es", "eses"):
        return STEP_OF["e"], -(len(name) // 2)
    if name in ("as", "ases"):
        return STEP_OF["a"], -(len(name) // 2)
    alter = {"": 0, "is": 1, "isis": 2, "es": -1, "eses": -2}[name[1:]]
    return STEP_OF[name[0]], alter


def octave_shift(marks: str) -> int:
    return marks.count("'") - marks.count(",")


def relative_index(prev: int, step: int, marks: str) -> int:
    """LilyPond \\relative: the octave nearest the previous note, then marks."""
    base = prev - (prev % 7) + step
    while base - prev > 3:
        base -= 7
    while prev - base > 3:
        base += 7
    return base + 7 * octave_shift(marks)


def to_midi(index: int, alter: int) -> int:
    octave, step = divmod(index, 7)
    return 48 + 12 * octave + STEP_SEMITONES[step] + alter


# --------------------------------------------------------------------------
# Music events
# --------------------------------------------------------------------------

@dataclass
class Event:
    start: Fraction            # in whole notes from the start of the movement
    dur: Fraction
    pitches: list[int]         # empty for rests
    grace: bool = False
    tie: bool = False
    marks: list[str] = field(default_factory=list)


def interpret(rel_start: str, body: str, end: Fraction) -> list[Event]:
    m = re.match(r"([a-g](?:is|es)*)([',]*)", rel_start)
    step, _ = parse_pitch(m.group(1))
    prev = step + 7 * octave_shift(m.group(2))

    events: list[Event] = []
    t = Fraction(0)
    dur = Fraction(1, 4)
    brace_kinds: list[str] = []
    pending_grace = False
    grace_depth = 0
    chord: list[int] | None = None
    chord_ref = chord_first = 0
    last: Event | None = None

    def length_of(d: str | None, dots: str) -> Fraction:
        nonlocal dur
        if d:
            base = length = Fraction(1, int(d))
            for i in range(len(dots)):
                length += base / (2 ** (i + 1))
            dur = length
        return dur

    for tok in tokenize(body):
        if t >= end and grace_depth == 0:
            break  # past the excerpt; later bars use syntax we don't need
        kind = tok.lastgroup
        if tok.group("note"):
            step, alter = parse_pitch(tok.group("note"))
            if chord is not None:
                # inside <...>: each note is relative to the previous chord note
                idx = relative_index(chord_ref if chord else prev, step, tok.group("oct"))
                if not chord:
                    chord_first = idx
                chord_ref = idx
                chord.append(to_midi(idx, alter))
                continue
            idx = relative_index(prev, step, tok.group("oct"))
            prev = idx
            length = length_of(tok.group("dur"), tok.group("dots"))
            last = Event(t, length, [to_midi(idx, alter)], grace=grace_depth > 0)
            events.append(last)
            if not last.grace:
                t += length
        elif tok.group("rest"):
            length = length_of(tok.group("rdur"), tok.group("rdots"))
            if tok.group("mul"):
                length *= int(tok.group("mul")[1:])
            last = Event(t, length, [])
            events.append(last)
            t += length
        elif tok.group("chordend"):
            length = length_of(tok.group("cdur"), tok.group("cdots"))
            last = Event(t, length, chord or [])
            events.append(last)
            prev = chord_first  # the chord's first note is the next reference
            chord = None
            t += length
        elif kind == "art":
            if tok.group("art")[1] == "." and last is not None:
                last.marks.append("art:staccato")
        elif kind == "cmd":
            c = tok.group("cmd")[1:]
            if c == "grace":
                pending_grace = True
            elif last is None:
                continue
            elif c in DYNAMICS:
                last.marks.append(f"dyn:{c}")
            elif c == "<":
                last.marks.append("hairpin:cresc")
            elif c == ">":
                last.marks.append("hairpin:dim")
            elif c == "!":
                last.marks.append("hairpin:end")
            elif c == "trill":
                last.marks.append("orn:trill")
            # every other command only affects layout
        elif kind == "sym":
            s = tok.group("sym")
            if s == "{":
                brace_kinds.append("grace" if pending_grace else "seq")
                grace_depth += pending_grace
                pending_grace = False
            elif s == "}":
                if brace_kinds.pop() == "grace":
                    grace_depth -= 1
            elif s == "<":
                chord = []
            elif s == "(" and last is not None:
                last.marks.append("slur:start")
            elif s == ")" and last is not None:
                last.marks.append("slur:end")
            elif s == "~" and last is not None:
                last.tie = True
            elif s == "|" and t % 1 != 0:
                raise SystemExit(f"bar check failed at whole-note offset {t}")
    return events


@dataclass
class Note:
    tick: int
    ticks: int
    pitch: int
    velocity: int
    marks: list[str]


def to_notes(events: list[Event], transpose: int, end: Fraction) -> list[Note]:
    whole = 4 * PPQ
    notes: list[Note] = []
    open_ties: dict[int, Note] = {}
    dynamic = "p"
    for i, ev in enumerate(events):
        if ev.start >= end:
            break
        for mark in ev.marks:
            if mark.startswith("dyn:"):
                dynamic = mark[4:]
        if not ev.pitches:
            open_ties.clear()
            continue
        tick = int(ev.start * whole)
        ticks = int(min(ev.dur, end - ev.start) * whole)
        marks = list(dict.fromkeys(ev.marks))  # de-duplicate, keep order
        if ev.grace:
            ticks = GRACE_TICKS
            marks.append("grace")
        for p in ev.pitches:
            pitch = p + transpose
            tied = open_ties.pop(pitch, None)
            if tied is not None and tied.tick + tied.ticks == tick:
                tied.ticks += ticks
                tied.marks += [m for m in marks if m not in tied.marks]
                if ev.tie:
                    open_ties[pitch] = tied
                continue
            note = Note(tick, ticks, pitch, VELOCITY[dynamic], marks)
            notes.append(note)
            if ev.tie:
                open_ties[pitch] = note
        if not ev.tie:
            open_ties.clear()
        for mark in ev.marks:
            if mark.startswith("dyn:") and AFTER_ACCENT.get(mark[4:]):
                dynamic = AFTER_ACCENT[mark[4:]]

    # Grace notes sound on the beat, one after another, and borrow their
    # combined length from the main note that follows them.
    i = 0
    while i < len(notes):
        if "grace" not in notes[i].marks:
            i += 1
            continue
        j = i
        while j < len(notes) and "grace" in notes[j].marks:
            notes[j].tick = notes[i].tick + (j - i) * GRACE_TICKS
            j += 1
        if j < len(notes):
            borrowed = (j - i) * GRACE_TICKS
            notes[j].tick += borrowed
            notes[j].ticks -= borrowed
        i = j
    return notes


# --------------------------------------------------------------------------
# Standard MIDI File writer
# --------------------------------------------------------------------------

def vlq(value: int) -> bytes:
    out = [value & 0x7F]
    value >>= 7
    while value:
        out.append(0x80 | (value & 0x7F))
        value >>= 7
    return bytes(reversed(out))


def meta(kind: int, data: bytes) -> bytes:
    return bytes([0xFF, kind]) + vlq(len(data)) + data


def write_midi(path: str, track_name: str, program: int, notes: list[Note]) -> None:
    channel = 0
    timed: list[tuple[int, int, bytes]] = [
        (0, 0, meta(0x03, track_name.encode())),
        (0, 0, meta(0x51, struct.pack(">I", 60_000_000 // TEMPO_QPM)[1:])),
        (0, 0, meta(0x58, bytes([4, 2, 24, 8]))),
        (0, 0, meta(0x59, bytes([3, 0]))),  # three sharps, major
        (0, 0, bytes([0xC0 | channel, program])),
    ]
    for n in notes:
        for mark in n.marks:
            timed.append((n.tick, 1, meta(0x01, mark.encode())))
        timed.append((n.tick, 3, bytes([0x90 | channel, n.pitch, n.velocity])))
        timed.append((n.tick + n.ticks, 2, bytes([0x80 | channel, n.pitch, 0])))
    timed.sort(key=lambda e: (e[0], e[1]))
    end_tick = LAST_BAR * 4 * PPQ
    data, now = bytearray(), 0
    for tick, _, payload in timed:
        data += vlq(tick - now) + payload
        now = tick
    data += vlq(max(0, end_tick - now)) + meta(0x2F, b"")
    with open(path, "wb") as f:
        f.write(b"MThd" + struct.pack(">IHHH", 6, 1, 1, PPQ))
        f.write(b"MTrk" + struct.pack(">I", len(data)) + data)


NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]


def name(pitch: int) -> str:
    return f"{NAMES[pitch % 12]}{pitch // 12 - 1}"


def main() -> None:
    dump = "--dump" in sys.argv
    os.makedirs(OUT, exist_ok=True)
    end = Fraction(LAST_BAR)
    for file, variable, out_name, track_name, program, transpose in PARTS:
        rel, body = extract_music(os.path.join(SRC, file), variable)
        notes = to_notes(interpret(rel, body, end), transpose, end)
        path = os.path.join(OUT, f"{out_name}.mid")
        write_midi(path, track_name, program, notes)
        print(f"{track_name:<14} {len(notes):4d} notes -> {os.path.relpath(path, ROOT)}")
        if dump:
            for n in notes:
                bar, beat = divmod(Fraction(n.tick, PPQ), 4)
                print(f"   bar {int(bar) + 1:2d} beat {float(beat) + 1:5.3f} "
                      f"{name(n.pitch):4s} len {n.ticks / PPQ:5.3f} v{n.velocity:3d} "
                      f"{' '.join(n.marks)}")


if __name__ == "__main__":
    main()
