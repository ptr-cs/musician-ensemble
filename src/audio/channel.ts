import * as Tone from 'tone';
import type { Persona } from '../performance/personas';
import { BODY, NOISE_BAND, TRIM } from './timbre';

/**
 * One musician's place on stage: the instrument body, a shared noise source
 * for bow / breath noise, a slow pitch drift, and the stage position.
 */
export class InstrumentChannel {
  /** Voices connect their output here. */
  readonly input: Tone.Gain;
  /** Band-limited noise that voices tap for bow / breath noise. */
  readonly noise: Tone.Gain;
  /** A slow drift in cents that voices add to their detune. */
  readonly drift: Tone.Gain;

  private readonly sources: (Tone.Noise | Tone.Oscillator)[] = [];
  private readonly nodes: Tone.ToneAudioNode[] = [];

  constructor(readonly persona: Persona, dry: Tone.InputNode, reverb: Tone.InputNode) {
    const kind = persona.instrument;
    this.input = new Tone.Gain(1);
    const body = BODY[kind].map((r) => new Tone.Filter({ type: r.type, frequency: r.frequency, gain: r.gain, Q: r.Q ?? 1 }));
    const trim = new Tone.Gain(Tone.dbToGain(TRIM[kind]));
    const panner = new Tone.Panner(persona.pan);
    const send = new Tone.Gain(kind === 'cello' ? 0.32 : 0.38);
    this.input.chain(...body, trim, panner);
    panner.connect(dry);
    panner.connect(send);
    send.connect(reverb);

    const band = NOISE_BAND[kind];
    const noise = new Tone.Noise('pink');
    const noiseFilter = new Tone.Filter({ type: 'bandpass', frequency: band.frequency, Q: band.Q });
    this.noise = new Tone.Gain(band.level);
    noise.chain(noiseFilter, this.noise);

    // two incommensurate slow oscillators: a few cents of natural pitch drift
    this.drift = new Tone.Gain(1);
    const driftA = new Tone.Oscillator(0.21 + Math.random() * 0.1, 'sine');
    const driftB = new Tone.Oscillator(0.67 + Math.random() * 0.2, 'sine');
    const driftGainA = new Tone.Gain(kind === 'clarinet' ? 1.5 : 2);
    const driftGainB = new Tone.Gain(1);
    driftA.chain(driftGainA, this.drift);
    driftB.chain(driftGainB, this.drift);

    this.sources.push(noise, driftA, driftB);
    this.nodes.push(this.input, ...body, trim, panner, send, noiseFilter, this.noise, this.drift, driftGainA, driftGainB);
  }

  start(time: number): void {
    for (const s of this.sources) if (s.state !== 'started') s.start(time);
  }

  stop(time: number): void {
    for (const s of this.sources) if (s.state === 'started') s.stop(time);
  }

  dispose(): void {
    for (const s of this.sources) s.dispose();
    for (const n of this.nodes) n.dispose();
  }
}
