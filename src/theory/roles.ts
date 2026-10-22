import { PART_IDS, type PartId, type Score, type ScoreNote } from '../score/score';

export type Role = 'melody' | 'counter' | 'harmony' | 'bass' | 'rest';

/** Soloist habits of the genre: the clarinet and first violin lead most. */
const PART_BIAS: Record<PartId, number> = {
  clarinet: 0.35, violin1: 0.25, violin2: 0, viola: -0.1, cello: -0.2,
};

export interface RoleMap {
  leader: PartId[];                  // per beat
  roles: Record<PartId, Role[]>;     // per beat
}

/**
 * Decide, beat by beat, who carries the melody. Salience rewards melodic
 * motion, rhythmic activity, being the top voice and having just entered,
 * and penalises repeated-note accompaniment figures and static held notes.
 * Hysteresis keeps the lead from flickering between parts.
 */
export function assignRoles(score: Score): RoleMap {
  const beats = score.totalBeats;
  const main: Record<PartId, ScoreNote[]> = {} as Record<PartId, ScoreNote[]>;
  for (const id of PART_IDS) main[id] = score.parts[id].notes.filter((n) => n.lane === 0 && !n.marks.grace);

  const soundingAt = (id: PartId, from: number, to: number) =>
    main[id].filter((n) => n.start < to && n.start + n.dur > from);

  const leader: PartId[] = [];
  const roles = Object.fromEntries(PART_IDS.map((id) => [id, [] as Role[]])) as Record<PartId, Role[]>;
  let current: PartId | null = null;

  for (let b = 0; b < beats; b++) {
    const salience = new Map<PartId, number>();
    const topPitch = Math.max(...PART_IDS.flatMap((id) => soundingAt(id, b, b + 1).map((n) => n.pitch)), -Infinity);

    for (const id of PART_IDS) {
      if (soundingAt(id, b, b + 1).length === 0) continue;
      const win = soundingAt(id, b - 1, b + 2);
      let moves = 0, repeats = 0;
      for (let i = 1; i < win.length; i++) {
        if (win[i].pitch === win[i - 1].pitch) repeats++;
        else moves++;
      }
      let s = 0.35 * Math.min(moves, 6) - (moves === 0 ? 0.25 : 0.12) * repeats;
      if (win.some((n) => n.pitch === topPitch)) s += 0.6;
      if (win.length === 1 && win[0].dur >= 3) s -= 0.3;
      const entered = win.find((n) => n.start >= b - 2 && n.restBefore >= 1);
      if (entered) s += 0.5;
      s += PART_BIAS[id];
      salience.set(id, s);
    }

    let best: PartId | null = null;
    for (const [id, s] of salience) if (best === null || s > salience.get(best)!) best = id;
    if (current && salience.has(current) && best && salience.get(best)! < salience.get(current)! + 0.4) {
      best = current;
    }
    current = best;
    const lead = best ?? leader[b - 1] ?? 'violin1';
    leader.push(lead);

    const lowest = [...salience.keys()].reduce<PartId | null>((low, id) => {
      const p = Math.min(...soundingAt(id, b, b + 1).map((n) => n.pitch));
      const lp = low ? Math.min(...soundingAt(low, b, b + 1).map((n) => n.pitch)) : Infinity;
      return p < lp ? id : low;
    }, null);

    const leadOnsets = new Set(soundingAt(lead, b - 1, b + 2).map((n) => n.start));
    for (const id of PART_IDS) {
      let role: Role;
      if (!salience.has(id)) role = 'rest';
      else if (id === best) role = 'melody';
      else if (id === lowest) role = 'bass';
      else {
        const win = soundingAt(id, b - 1, b + 2);
        const shared = win.filter((n) => leadOnsets.has(n.start)).length;
        const moving = new Set(win.map((n) => n.pitch)).size > 1;
        role = moving && win.length > 1 && shared / win.length >= 0.7 ? 'counter' : 'harmony';
      }
      roles[id].push(role);
    }
  }
  return { leader, roles };
}
