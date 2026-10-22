import * as Tone from 'tone';
import type { InstrumentKind, Persona } from '../performance/personas';
import type { GesturePlan } from '../performance/types';
import { midiToHz } from '../theory/pitch';
import type { InstrumentChannel } from './channel';
import { cutoffFor, partials } from './timbre';

/**
 * Sounds one planned gesture in real time: an oscillator with the
 * instrument's spectrum, pitch automation for slurred notes and trills, a
 * vibrato LFO whose depth and speed are automated note by note, a loudness
 * envelope, a brightness filter that follows it, and bow / breath noise.
 *
 * The automation can be rescheduled from any moment on, which is how the
 * ensemble follows a live conductor in the middle of a long slur.
 */
export class GestureVoice {
  private readonly osc: Tone.Oscillator;
  private readonly vib: Tone.Oscillator | null;
  private readonly vibDepth: Tone.Gain | null;
  private readonly filter: Tone.Filter;
  private readonly noiseTap: Tone.Gain;
  private readonly amp: Tone.Gain;
  private readonly kind: InstrumentKind;
  private readonly brightness: number;
  private disposed = false;
  private released = false;

  constructor(
    private readonly plan: GesturePlan,
    private readonly channel: InstrumentChannel,
    persona: Persona,
    private readonly origin: number,
  ) {
    this.kind = persona.instrument;
    this.brightness = persona.brightness;
    const f0 = midiToHz(plan.pitch[0].midi);
    const startAt = this.at(plan.start) - 0.005;

    this.osc = new Tone.Oscillator({ frequency: f0, type: 'custom', partials: partials(this.kind, f0), phase: Math.random() * 360 });
    this.filter = new Tone.Filter({ type: 'lowpass', frequency: cutoffFor(this.kind, f0, -30, this.brightness), Q: 0.6, rolloff: -12 });
    this.amp = new Tone.Gain(0);
    this.noiseTap = new Tone.Gain(0);
    this.osc.chain(this.filter, this.amp, channel.input);
    channel.noise.connect(this.noiseTap);
    this.noiseTap.connect(this.filter);
    channel.drift.connect(this.osc.detune);

    if (plan.vibrato.length) {
      this.vib = new Tone.Oscillator({ frequency: plan.vibrato[0].rate, type: 'sine', phase: Math.random() * 360 });
      this.vibDepth = new Tone.Gain(0);
      this.vib.chain(this.vibDepth, this.osc.detune);
    } else {
      this.vib = null;
      this.vibDepth = null;
    }

    this.osc.frequency.setValueAtTime(f0, startAt);
    this.amp.gain.setValueAtTime(0, startAt);
    this.apply(startAt);
    // no scheduled stop: the engine disposes the voice once it has finished,
    // so a conductor slowing down can never cut a note short
    this.osc.start(startAt);
    this.vib?.start(startAt);
  }

  get part() {
    return this.plan.part;
  }

  /** Audio-context time at which the gesture has fully died away. */
  get endAt(): number {
    return this.at(this.plan.end) + 0.05;
  }

  private at(t: number): number {
    return this.origin + t;
  }

  /** The plan's times were moved (live conducting): reschedule from `from`. */
  reschedule(from: number): void {
    if (this.disposed || this.released) return;
    const params: { cancelAndHoldAtTime(time: number): unknown }[] = [
      this.osc.frequency, this.amp.gain, this.filter.frequency, this.noiseTap.gain,
    ];
    if (this.vib && this.vibDepth) params.push(this.vibDepth.gain, this.vib.frequency);
    for (const p of params) p.cancelAndHoldAtTime(from);
    this.apply(from);
  }

  /** Schedule every automation point that falls after `from`. */
  private apply(from: number): void {
    const plan = this.plan;
    // automation times must strictly increase for each parameter
    const clock = () => ({ t: from });
    const after = (last: { t: number }, t: number) => (last.t = Math.max(this.at(t), last.t + 0.001));

    // pitch: slurred note changes glide over a few ms, like a finger landing
    const freq = this.osc.frequency;
    let lastTime = from;
    for (let i = 1; i < plan.pitch.length; i++) {
      const t = this.at(plan.pitch[i].t);
      if (t <= from) continue;
      const hz = midiToHz(plan.pitch[i].midi);
      const glide = Math.min(plan.glide, (t - lastTime) * 0.5);
      freq.setValueAtTime(midiToHz(plan.pitch[i - 1].midi), Math.max(t - glide, lastTime + 0.001));
      freq.exponentialRampToValueAtTime(hz, t);
      lastTime = t;
    }

    // loudness and the brightness that goes with it
    const pitchAt = (t: number) => {
      let m = plan.pitch[0].midi;
      for (const p of plan.pitch) if (p.t <= t) m = p.midi;
      return midiToHz(m);
    };
    const levelClock = clock();
    for (const pt of plan.level) {
      if (this.at(pt.t) <= from) continue;
      const t = after(levelClock, pt.t);
      this.amp.gain.exponentialRampToValueAtTime(Tone.dbToGain(pt.db), t);
      this.filter.frequency.exponentialRampToValueAtTime(cutoffFor(this.kind, pitchAt(pt.t), pt.db, this.brightness), t);
    }

    const noiseClock = clock();
    for (const pt of plan.noise) {
      if (this.at(pt.t) <= from) continue;
      this.noiseTap.gain.linearRampToValueAtTime(pt.amount, after(noiseClock, pt.t));
    }

    if (this.vib && this.vibDepth) {
      const vibClock = clock();
      for (const v of plan.vibrato) {
        if (this.at(v.t) <= from) continue;
        const t = after(vibClock, v.t);
        this.vibDepth.gain.linearRampToValueAtTime(v.cents, t);
        this.vib.frequency.linearRampToValueAtTime(Math.max(0.1, v.rate), t);
      }
    }
  }

  /** Fade out quickly (used when the performance is stopped). */
  release(time: number): void {
    if (this.disposed || this.released || time >= this.endAt) return;
    this.released = true;
    const g = this.amp.gain;
    g.cancelAndHoldAtTime(time);
    g.linearRampToValueAtTime(0, time + 0.12);
    this.osc.stop(time + 0.15);
    this.vib?.stop(time + 0.15);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    try {
      this.channel.noise.disconnect(this.noiseTap);
      this.channel.drift.disconnect(this.osc.detune);
    } catch {
      // the channel may already be gone
    }
    this.osc.dispose();
    this.vib?.dispose();
    this.vibDepth?.dispose();
    this.filter.dispose();
    this.noiseTap.dispose();
    this.amp.dispose();
  }
}
