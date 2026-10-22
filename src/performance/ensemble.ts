import type { PartId } from '../score/score';
import type { GesturePlan } from './types';

/**
 * What the musicians hear of each other. Every planned gesture is published
 * here, so a player deciding how to shape a note can ask how loud the melody
 * will be and how fast its vibrato is at that moment.
 */
export class EnsembleState {
  private gestures = new Map<PartId, GesturePlan[]>();

  publish(plan: GesturePlan): void {
    const list = this.gestures.get(plan.part) ?? [];
    list.push(plan);
    // keep only recent history
    if (list.length > 64) list.splice(0, list.length - 64);
    this.gestures.set(plan.part, list);
  }

  private noteAt(part: PartId, time: number) {
    const list = this.gestures.get(part);
    if (!list) return null;
    for (let i = list.length - 1; i >= 0; i--) {
      const g = list[i];
      if (g.start > time || g.end < time) continue;
      for (const n of g.notes) if (n.t0 <= time && n.t1 >= time) return n;
    }
    return null;
  }

  /** Planned level of a part at a time (dB), or null if silent / unknown. */
  levelAt(part: PartId, time: number): number | null {
    return this.noteAt(part, time)?.db ?? null;
  }

  vibratoRateAt(part: PartId, time: number): number | null {
    const list = this.gestures.get(part);
    if (!list) return null;
    for (let i = list.length - 1; i >= 0; i--) {
      const g = list[i];
      if (g.start <= time && g.end >= time && g.vibrato.length) {
        return g.vibrato[g.vibrato.length - 1].rate || null;
      }
    }
    return null;
  }

  reset(): void {
    this.gestures.clear();
  }
}
