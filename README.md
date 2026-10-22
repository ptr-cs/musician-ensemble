# Musician Ensemble

Five virtual musicians perform the opening of Mozart's Clarinet Quintet in A major, K. 581 (I. Allegro, bars 1–39, the first two pages of `IMSLP01455-K581-score-a4.pdf`). Nothing is pre-rendered. While the music plays, each musician decides how to shape every phrase, note and vibrato cycle, a fraction of a second before it sounds. The sound is then synthesised live with Tone.js.

```sh
npm install
npm run dev        # open the printed URL and press Perform
npm run build      # type-check and produce dist/
npm run midi       # regenerate public/midi/*.mid from the score source
```

Use **Interpretive / Literal** to compare the same score played as written (metronomic, flat dynamics, no vibrato) against the interpretation. Every interpretive take is different.

## Conducting with your camera

Press **Conduct** to open the conductor panel. It shows your camera, mirrored, with one dashed **downbeat** line near the bottom. Drag the line to where your beat lands; the position is remembered. Every stroke down through the line is a beat.

1. The ensemble waits, watching. Beat once through the line to count in.
2. Beat again: the musicians come in on this second beat, at the tempo your two beats set. They read the beat coming from your hand's speed, as players do, rather than reacting late.
3. Keep beating, **in 2** (half notes, the default for this Allegro) or **in 4**. The ensemble follows your tempo and phase each beat, re-timing notes it has already planned. It typically stays within a few tens of milliseconds of your beat.
4. Make bigger gestures (a higher rebound between beats) for more sound, smaller ones for less.

After each take the ensemble waits for you again.

How it works:

- **Hand tracking.** Uses MediaPipe's hand landmark model (`src/conductor/handTracker.ts`). The WASM runtime is served by the app itself; the model (about 7.5 MB) downloads from Google's model storage the first time you conduct. If that isn't possible, for example offline, the app falls back to motion tracking, which works when your conducting hand is the main thing moving. Add `?tracker=motion` to the URL to force the fallback.
- **Reading the gesture.** `src/conductor/beatDetector.ts` turns the hand's height into anticipated and actual beats (ictus), timed from each camera frame's capture time.
- **Following.** `src/conductor/follower.ts` holds the following logic. The camera needs a secure page: `localhost` or https.

## Layout

The page adapts to desktop, tablet and phone. The stage arranges itself by the width it actually has:

- an arc of five on wide screens
- three in front and two behind on tablets, or beside the docked conductor panel
- two by two with the cello centred on phones

The transport stays pinned to the bottom of the screen when the page scrolls. The conductor panel docks as a sidebar from tablet-landscape width up, and floats as a picture-in-picture card (which can be minimised) below that.

## The MIDI files

`public/midi/{clarinet,violin1,violin2,viola,cello}.mid` contain bars 1–39, one file per instrument. They are at concert pitch: the clarinet in A sounds a minor third below written.

The PDF is a vector engraving produced by the Mutopia Project from LilyPond source (its footer reads `Mutopia-2003/07/17-337`). Rather than run optical music recognition on the page images, `tools/ly2midi.py` converts that same source directly, which is exact. The five part files are vendored in `tools/ly-source/` (public domain), and the conversion was checked against the PDF pages.

The script has no dependencies. It handles the parts of LilyPond these bars use (relative pitch, chords, ties, slurs, grace notes, dynamics, hairpins, staccato, trills) and verifies every bar line.

Standard MIDI cannot represent slurs or articulation, so the converter also writes the markings as text meta-events at each note's onset: `slur:start`, `slur:end`, `art:staccato`, `orn:trill`, `grace`, `dyn:p`, `hairpin:cresc` and so on. The app's own MIDI reader (`src/score/midi.ts`) keeps them. Other MIDI software simply ignores them.

## How the musicians work

```
score/        MIDI + markings  ->  notes with slur groups, written dynamics, hairpins
theory/       the musicians study the score before playing
performance/  conductor + five musicians decide how to play, live
audio/        Tone.js synthesis of each planned gesture
ui/           stage, score strip, transport
```

### Studying the score (`src/theory`)

- **Key.** Krumhansl–Kessler key profiles are correlated bar by bar, then a Viterbi pass finds the most likely sequence of keys and charges for each modulation. Result: A major, with the move to the dominant (E major) at bar 26.
- **Harmony.** Each beat's chord is found by template matching, giving its Roman numeral (including applied dominants), function (tonic, subdominant, dominant) and a tension value.
- **Note function.** Every note is classified as a chord tone, passing note, neighbour note, appoggiatura, suspension, anticipation or escape note. The analysis also detects resolutions, leading tones and two-note "sigh" figures.
- **Roles.** Beat by beat, the analysis decides who has the melody and who is playing countermelody, harmony or bass. It uses melodic salience with some inertia so the lead doesn't flicker. It follows violin I → clarinet → violin I → cello → violin I → clarinet.
- **Phrases.** Phrase boundaries come from cadences and melodic hand-offs (9 phrases). Each phrase gets a cadence type (authentic, half or open) and an expressive high point.

### Playing (`src/performance`)

The **conductor** keeps the ensemble's shared time. It builds a tempo map in the spirit of the KTH performance rules (Friberg, Bresin & Sundberg):

- Each phrase pushes forward towards its high point and relaxes into its cadence.
- Harmonic tension broadens the pulse slightly.
- There is a breath after each cadence and a final ritardando.
- The shape is redrawn for every performance.

Each **musician** has a persona (vibrato width and speed, timing scatter, articulation, tone colour). A slur is played as one continuous gesture, a single bow stroke or breath, with the pitch changing underneath. For each gesture the musician decides:

- **Dynamics.** Starts from the written dynamic and hairpins, then adjusts for:
  - the musician's role
  - the phrase arch (macro swell)
  - "high is intense" (higher notes a little louder)
  - harmonic tension
  - leaning into appoggiaturas and suspensions, with softer resolutions
  - two-note sighs
  - metric weight
  - a slur growing with its line and lightening at its end
  
  Within each note there is a micro-shape: a messa di voce (swell and taper), a swell towards a higher next note, a lean and release on dissonances, a settling sustain for held chords, and a bite-then-hush for sfp/fp.
- **Articulation.** Legato within slurs, with a slight dip at each finger change. Unslurred notes are detached by an amount depending on length and context. Light, short repeated accompaniment notes. Staccato, and portato (dots under a slur, separated within one bow). An appoggiatura flows into its resolution even without a slur. Releases ring longer before rests.
- **Vibrato.** For the strings only, delayed and blooming on long notes. Its depth depends on role, intensity and how expressive the note is. Fast passages get little; a long open-string note is stopped with the 4th finger so it can vibrate. Accompanists entrain their vibrato speed to the melody's. The clarinet uses no vibrato, which is idiomatic, and shapes with breath instead.
- **Intonation.** For melody notes, leading tones are tuned high and chromatic notes lean towards where they resolve. For sustained chord tones, tuning moves towards just intonation: major thirds low, minor thirds high, dominant sevenths low.
- **Ornaments.** Classical trills start on the upper note, accelerate, and settle before the written turn. Grace notes are short and on the beat.
- **Timing.** The melody leads by a few milliseconds, every player scatters a little, and gestures follow the conductor's rubato.
- **Listening.** Every planned gesture is published to a shared ensemble state. Accompanists check how loud the melody will be and stay under it, and the melody plans first in each window.

The stage shows each musician's current note (with its tuning offset in cents), dynamic, live vibrato trace, role, and a caption explaining the current decision.

### Sound (`src/audio`)

Every gesture is synthesised live as:

- an oscillator with the instrument's spectrum (Helmholtz sawtooth with bow-position comb dips for strings; odd-harmonic-dominant, register-dependent spectrum for the clarinet)
- frequency automation for slurs and trills
- a vibrato LFO whose depth and rate are automated note by note
- a loudness envelope, with a low-pass filter that tracks it (louder is brighter)
- bow or breath noise

Each instrument also has body resonances, stage panning and a slow natural pitch drift. Everything goes into a convolution hall reverb and a gentle mastering chain.

## Limitations

- The instruments are synthesised, not sampled. That is what makes note-level control of vibrato, swells and intonation possible, but the timbres are stylised rather than recordings of real instruments.
- The interpretation is rule-based, not a trained model: the music theory and performance-practice knowledge above, plus controlled randomness.
