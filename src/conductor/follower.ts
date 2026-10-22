import type { Conductor } from '../performance/conductor';
import { clamp } from '../performance/random';

export interface FollowDecision {
  /** New seconds per quarter-note beat, from `now` on. */
  spb: number;
  /** Score beat the conductor's beat was matched to. */
  target: number;
  /** Ensemble ahead (+) or behind (-) of the conductor, in beats. */
  error: number;
}

/**
 * How an ensemble follows a conductor's beat. Each beat is matched to the
 * nearest conducted beat of the score; the beat interval is tracked with
 * smoothing (ignoring outliers such as a missed beat); and the tempo for the
 * coming beat is chosen so the ensemble arrives on the next beat together
 * with the conductor, correcting three quarters of the present drift,
 * as players do, so a single uneven beat does not jolt the music.
 */
export class BeatFollower {
  interval: number;
  private last: number | null = null;

  constructor(
    /** Quarter-note beats per conducted beat (2 = conducting "in 2"). */
    public unit: number,
    initialSpb: number,
  ) {
    this.interval = initialSpb * unit;
  }

  /** Performance-time `t` of a conducted beat; changes apply from `now`. */
  follow(conductor: Conductor, t: number, now: number): FollowDecision {
    const unit = this.unit;
    const heard = conductor.beatAt(t);
    const target = Math.round(heard / unit) * unit;
    const error = heard - target;

    if (this.last !== null) {
      const gap = t - this.last;
      if (gap > this.interval * 0.45 && gap < this.interval * 2.2) {
        this.interval = 0.5 * this.interval + 0.5 * gap;
      }
    }
    this.last = t;

    const goal = target + unit + 0.25 * error;
    const beatsLeft = goal - conductor.beatAt(now);
    const nominal = this.interval / unit;
    let spb = beatsLeft > 0.05 ? (t + this.interval - now) / beatsLeft : nominal;
    spb = clamp(spb, nominal * 0.65, nominal * 1.5);
    return { spb: clamp(spb, 0.25, 1.25), target, error };
  }

  /** The first beat in: tempo from the count-in. */
  start(spb: number): void {
    this.interval = spb * this.unit;
    this.last = 0;
  }
}
