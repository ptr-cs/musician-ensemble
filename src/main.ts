import './styles.css';
import { PerformanceEngine, type PartSnapshot } from './audio/engine';
import { PERSONAS } from './performance/personas';
import { loadScore, PART_IDS, type PartId } from './score/score';
import { analyse } from './theory/analysis';
import { ConductorPanel } from './ui/conductorPanel';
import { ScoreView } from './ui/scoreView';
import { Stage } from './ui/stage';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const app = $('app');
const playButton = $<HTMLButtonElement>('play');
const playLabel = $('play-label');
const playIcon = document.getElementById('play-icon')!;
const conductButton = $<HTMLButtonElement>('conduct');
const status = $('status');
const barOut = $('bar');
const beatOut = $('beat');
const tempoOut = $('tempo');
const insight = {
  key: $('insight-key'),
  chord: $('insight-chord'),
  phrase: $('insight-phrase'),
  lead: $('insight-lead'),
};

const PLAY_PATH = 'M8 5v14l11-7z';
const STOP_PATH = 'M7 7h10v10H7z';

async function main(): Promise<void> {
  playButton.disabled = true;
  const score = await loadScore(`${import.meta.env.BASE_URL}midi/`);
  const analysis = analyse(score);
  const engine = new PerformanceEngine(score, analysis);
  const stage = new Stage($('stage'));
  const scoreView = new ScoreView($<HTMLCanvasElement>('score'), score, analysis);


  let expressive = true;
  let take = 0;
  let busy = false;
  let conducting = false;

  const newSeed = () => (Date.now() ^ (++take * 2654435761)) >>> 0;
  const describeStudy = () => {
    const cadences = analysis.phrases.filter((p) => p.cadence !== 'open').length;
    return `The musicians have studied the score: ${analysis.phrases.length} phrases, ${cadences} cadences, a modulation from A major to E major.`;
  };
  status.textContent = describeStudy();
  playButton.disabled = false;

  /** Keep the main button in step with the engine. */
  const syncButton = () => {
    const state = engine.state;
    const label = state === 'playing' ? 'Stop' : state === 'armed' ? 'Waiting for downbeat' : conducting ? 'Get ready' : 'Perform';
    playLabel.textContent = label;
    playIcon.setAttribute('d', state === 'idle' ? PLAY_PATH : STOP_PATH);
    playButton.setAttribute('aria-label', state === 'armed' ? 'Cancel: stop waiting for the downbeat' : label);
    playButton.classList.toggle('waiting', state === 'armed');
  };

  const arm = async () => {
    await engine.arm(expressive, newSeed());
    syncButton();
    status.textContent = `Take ${take}: the ensemble is watching you. Beat twice down through the line; they come in on the second.`;
  };

  const panel = new ConductorPanel({
    onIctus: (beat) => {
      const wasArmed = engine.state === 'armed';
      const info = engine.ictus({ time: engine.contextTimeAt(beat.time), amplitude: beat.amplitude, interval: beat.interval });
      if (wasArmed && engine.isPlaying) {
        syncButton();
        status.textContent = `Take ${take}: conducted live, starting at ♩ = ${Math.round(info?.qpm ?? 0)}. Bigger gestures, more sound.`;
      }
      return info;
    },
    onUnitChange: (unit) => (engine.beatUnit = unit),
    onClose: () => void setConducting(false),
    engineState: () => engine.state,
    gestureDb: () => engine.conductor?.gestureDb ?? 0,
  });
  app.appendChild(panel.el);
  // builds for hosts without camera access leave conductor mode out
  if (import.meta.env.VITE_CAMERA === 'off') conductButton.hidden = true;
  if (import.meta.env.DEV) Object.assign(window, { ensemble: { engine, score, analysis, panel } });
  engine.beatUnit = panel.unit;

  async function setConducting(on: boolean): Promise<void> {
    if (on === conducting) return;
    conducting = on;
    conductButton.setAttribute('aria-pressed', String(on));
    app.classList.toggle('conducting', on);
    if (on) {
      // the click is the user gesture that lets audio start
      const opening = panel.open();
      await engine.ensureGraph();
      if (engine.state !== 'idle') engine.stop();
      await arm();
      await opening;
    } else {
      panel.close();
      if (engine.state === 'armed') {
        engine.stop();
        status.textContent = describeStudy();
      } else if (engine.isPlaying && engine.isLive) {
        status.textContent = `The ensemble carries on at your last tempo.`;
      }
      syncButton();
    }
  }

  engine.onEnd = () => {
    syncButton();
    if (conducting) {
      status.textContent = 'Fine. Lift your hand for another take.';
      setTimeout(() => {
        if (conducting && engine.state === 'idle') void arm();
      }, 1500);
    } else {
      status.textContent = 'Fine. Perform again for a fresh interpretation: no two takes are alike.';
    }
  };

  playButton.addEventListener('click', async () => {
    if (busy) return;
    busy = true;
    try {
      if (engine.state !== 'idle') {
        engine.stop();
        status.textContent = conducting ? 'Stopped. Press Get ready to conduct again.' : 'Stopped. ' + describeStudy();
      } else if (conducting) {
        await arm();
      } else {
        await engine.play(expressive, newSeed());
        status.textContent = expressive
          ? `Take ${take}: interpretive, around ♩ = ${Math.round(engine.conductor!.baseQpm)}, shaped live phrase by phrase.`
          : `Take ${take}: literal, exactly as written at ♩ = 120, no shaping.`;
      }
    } catch (err) {
      console.error(err);
      status.textContent = `Could not start audio: ${(err as Error).message}`;
    } finally {
      syncButton();
      busy = false;
    }
  });

  conductButton.addEventListener('click', () => {
    void setConducting(!conducting).catch((err) => {
      console.error(err);
      status.textContent = `Conductor mode could not start: ${(err as Error).message}`;
    });
  });

  document.querySelectorAll<HTMLButtonElement>('.transport .mode button').forEach((btn) => {
    btn.addEventListener('click', () => {
      expressive = btn.dataset.mode === 'expressive';
      document.querySelectorAll<HTMLButtonElement>('.transport .mode button').forEach((b) => {
        const active = b === btn;
        b.classList.toggle('active', active);
        b.setAttribute('aria-checked', String(active));
      });
      if (engine.state === 'armed') void arm(); // the next take uses the new mode
      else if (!engine.isPlaying) {
        status.textContent = expressive
          ? 'Interpretive: phrasing, rubato, vibrato, swells, articulation and intonation decided live.'
          : 'Literal: the notes as written, metronomic, flat dynamics. Compare with the interpretive mode.';
      }
    });
  });

  let lastBeat = 0;
  const frame = () => {
    const playing = engine.isPlaying && !!engine.conductor;
    const time = engine.time;
    const beat = playing ? engine.conductor!.beatAt(Math.max(0, time)) : lastBeat;
    if (playing) lastBeat = beat;

    const snapshots = Object.fromEntries(
      PART_IDS.map((id) => [id, playing ? engine.snapshot(id, time) : idle()]),
    ) as Record<PartId, PartSnapshot>;
    stage.update(time, snapshots, playing);
    scoreView.draw(beat, engine.plans, time);

    const b = Math.min(beat, score.totalBeats - 0.001);
    barOut.textContent = String(Math.floor(b / score.beatsPerBar) + 1);
    beatOut.textContent = String(Math.floor(b % score.beatsPerBar) + 1);
    tempoOut.textContent = playing ? `♩ = ${engine.conductor!.qpmAt(beat).toFixed(1)}` : '♩ = —';

    const chord = analysis.chordAt(b);
    const phrase = analysis.phraseAt(b);
    insight.key.textContent = analysis.keyAt(b).name;
    insight.chord.textContent = `${chord.roman} · ${chord.label}`;
    insight.phrase.textContent = `${phrase.index + 1} of ${analysis.phrases.length}`;
    insight.lead.textContent = PERSONAS[analysis.leaderAt(b)].role.replace(' in A', '');

    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

function idle(): PartSnapshot {
  return { note: null, db: -90, vibratoCents: 0, intent: null, intentAge: Infinity, gesture: null };
}

main().catch((err) => {
  console.error(err);
  status.textContent = `Failed to load: ${(err as Error).message}`;
});
