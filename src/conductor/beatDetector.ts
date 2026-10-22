export type BeatEvent =
  /** The hand fell through the downbeat line: a beat. */
  | { type: 'ictus'; time: number; x: number; amplitude: number; interval: number | null }
  /** The hand is falling fast towards the line: when it will cross it. */
  | { type: 'anticipate'; time: number; x: number; amplitude: number; interval: number | null };

const LOST_AFTER = 0.4;       // s without a hand before the gesture resets
const MIN_GAP = 0.2;          // s between beats (faster than 300 per minute is noise)
const MAX_INTERVAL = 2.2;     // s; a longer gap starts the count again
const MIN_SPEED = 0.45;       // image heights per second, downward, at the beat
const MIN_REBOUND = 0.1;      // image heights the hand must rise between beats
/** A rebound this high (image heights) is a full-sized gesture. */
const FULL_GESTURE = 0.45;
/** How far ahead (s) a beat is predicted, from this close above the line. */
const ANTICIPATE = 0.16;
const ANTICIPATE_WITHIN = 0.3;

/**
 * Reads a conductor's beat from the height of the hand over time, using a
 * single downbeat line.
 *
 * A beat (ictus) is the moment the hand falls through the line, having
 * rebounded since the last one; the crossing time is interpolated between
 * video frames. Its amplitude, how high the hand rose before falling, is how
 * big the gesture was. The time since the previous beat gives the tempo.
 *
 * Players don't wait to see the beat land: once the falling hand is fast and
 * close to the line, its crossing time is predicted from its speed
 * ('anticipate'), so the ensemble can come in together with the conductor
 * despite camera latency.
 */
export class BeatDetector {
  /** Height of the downbeat line, as a fraction of the image (0 = top). */
  line = 0.7;
  /** Smoothed hand position, or null when no hand is seen. */
  position: { x: number; y: number } | null = null;

  private prevY = 0;
  private prevT = 0;
  private prevSpeed = 0;
  private lostSince: number | null = null;
  private peakY = 1;
  private lastIctus = -Infinity;
  private anticipated = false;

  /** Seconds since the last beat, or null if there hasn't been a recent one. */
  sinceLastBeat(t: number): number | null {
    const dt = t - this.lastIctus;
    return dt < MAX_INTERVAL ? dt : null;
  }

  push(point: { x: number; y: number } | null, t: number): BeatEvent[] {
    if (!point) {
      this.lostSince ??= t;
      if (t - this.lostSince > LOST_AFTER) this.reset();
      return [];
    }
    this.lostSince = null;

    const first = !this.position;
    const y = first ? point.y : this.position!.y + 0.7 * (point.y - this.position!.y);
    const x = first ? point.x : this.position!.x + 0.7 * (point.x - this.position!.x);
    this.position = { x, y };
    if (first) {
      this.prevY = this.peakY = y;
      this.prevT = t;
      return [];
    }

    const events: BeatEvent[] = [];
    const line = this.line;
    const dt = Math.max(1e-3, t - this.prevT);
    const speed = (y - this.prevY) / dt; // positive = moving down
    if (y < this.peakY) this.peakY = y;
    const rebound = line - this.peakY;
    const amplitude = rebound / FULL_GESTURE;
    const interval = (time: number) => {
      const gap = time - this.lastIctus;
      return gap < MAX_INTERVAL ? gap : null;
    };

    // a steady fall (two frames agree) in the last stretch before the line
    const steady = Math.min(speed, this.prevSpeed);
    if (!this.anticipated && y < line && y > line - ANTICIPATE_WITHIN && steady > 1 && rebound > MIN_REBOUND) {
      const eta = (line - y) / steady;
      if (eta < ANTICIPATE) {
        const time = t + eta;
        this.anticipated = true;
        events.push({ type: 'anticipate', time, x, amplitude, interval: interval(time) });
      }
    }

    if (this.prevY < line && y >= line && speed > MIN_SPEED) {
      const time = this.prevT + ((line - this.prevY) / (y - this.prevY)) * dt;
      if (time - this.lastIctus > MIN_GAP && rebound > MIN_REBOUND) {
        events.push({ type: 'ictus', time, x, amplitude, interval: interval(time) });
        this.lastIctus = time;
        this.anticipated = false;
        this.peakY = y;
      }
    }

    this.prevY = y;
    this.prevT = t;
    this.prevSpeed = speed;
    return events;
  }

  reset(): void {
    this.position = null;
    this.peakY = 1;
    this.anticipated = false;
  }
}
