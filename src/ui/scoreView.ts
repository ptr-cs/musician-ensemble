import type { GesturePlan } from '../performance/types';
import { PERSONAS } from '../performance/personas';
import { clamp } from '../performance/random';
import type { PartId, Score } from '../score/score';
import type { Analysis } from '../theory/analysis';

/** Score order, top to bottom. */
const ROWS: PartId[] = ['clarinet', 'violin1', 'violin2', 'viola', 'cello'];
const VISIBLE_BEATS = 26;
const PLAYHEAD = 0.28;
const SHORT_NAMES: Record<PartId, string> = {
  clarinet: 'Cl', violin1: 'Vn I', violin2: 'Vn II', viola: 'Va', cello: 'Vc',
};
const TOP = 56;

/**
 * A scrolling piano-roll of the score with the musicians' analysis drawn on
 * it: phrases and their cadences, the harmony, and a band showing which
 * instrument currently carries the melody. Notes light up with the dynamic
 * each musician actually chose.
 */
export class ScoreView {
  private ctx: CanvasRenderingContext2D;
  private colors: Record<PartId, string>;
  private width = 0;
  private height = 0;

  constructor(private canvas: HTMLCanvasElement, private score: Score, private analysis: Analysis) {
    this.ctx = canvas.getContext('2d')!;
    const css = getComputedStyle(document.documentElement);
    this.colors = Object.fromEntries(ROWS.map((id) => [id, css.getPropertyValue(`--${id}`).trim()])) as Record<PartId, string>;
    new ResizeObserver(() => this.resize()).observe(canvas);
    this.resize();
  }

  private resize(): void {
    const dpr = window.devicePixelRatio || 1;
    const rect = this.canvas.getBoundingClientRect();
    this.width = rect.width;
    this.height = rect.height;
    this.canvas.width = Math.round(rect.width * dpr);
    this.canvas.height = Math.round(rect.height * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  draw(beat: number, plans: GesturePlan[], time: number): void {
    const { ctx, width: w, height: h, score, analysis } = this;
    if (!w || !h) return;
    ctx.clearRect(0, 0, w, h);

    const narrow = w < 640;
    const LABEL_W = narrow ? 44 : 92;
    const visible = narrow ? 14 : VISIBLE_BEATS;
    const plotW = w - LABEL_W;
    const pxPerBeat = plotW / visible;
    const startBeat = beat - visible * PLAYHEAD;
    const x = (b: number) => LABEL_W + (b - startBeat) * pxPerBeat;
    const laneH = (h - TOP - 8) / ROWS.length;
    const laneY = (i: number) => TOP + i * laneH;
    const firstBeat = Math.max(0, Math.floor(startBeat));
    const lastBeat = Math.min(score.totalBeats, Math.ceil(startBeat + visible));

    // melody band: who leads, beat by beat
    for (let b = firstBeat; b < lastBeat; b++) {
      const lead = analysis.leaderAt(b);
      const row = ROWS.indexOf(lead);
      ctx.fillStyle = this.colors[lead];
      ctx.globalAlpha = 0.09;
      ctx.fillRect(x(b), laneY(row) + 1, pxPerBeat + 0.5, laneH - 2);
    }
    ctx.globalAlpha = 1;

    // bar lines and numbers
    ctx.font = '11px Inter, sans-serif';
    ctx.textBaseline = 'middle';
    for (let bar = Math.floor(firstBeat / 4); bar * 4 <= lastBeat; bar++) {
      const bx = x(bar * 4);
      if (bx < LABEL_W) continue;
      ctx.strokeStyle = 'rgba(255,240,220,0.08)';
      ctx.beginPath();
      ctx.moveTo(bx, TOP - 4);
      ctx.lineTo(bx, h - 6);
      ctx.stroke();
      ctx.fillStyle = 'rgba(255,240,220,0.35)';
      ctx.fillText(String(bar + 1), bx + 4, TOP - 10);
    }

    // phrases and harmony along the top
    ctx.font = 'italic 14px "Cormorant Garamond", serif';
    for (const p of analysis.phrases) {
      if (x(p.end) < LABEL_W || x(p.start) > w) continue;
      const x0 = Math.max(LABEL_W, x(p.start));
      const x1 = Math.min(w, x(p.end));
      ctx.strokeStyle = 'rgba(217,164,65,0.55)';
      ctx.beginPath();
      ctx.moveTo(x0 + 2, 9);
      ctx.lineTo(x1 - 2, 9);
      ctx.stroke();
      ctx.fillStyle = 'rgba(217,164,65,0.9)';
      const cadence = p.cadence === 'open' ? '' : ` · ${p.cadence} cadence`;
      ctx.fillText(narrow ? `Phrase ${p.index + 1}` : `Phrase ${p.index + 1}${cadence}`, x0 + 6, 19);
    }
    ctx.font = '500 11px Inter, sans-serif';
    ctx.fillStyle = 'rgba(243,236,226,0.6)';
    let lastRoman = '';
    let lastX = -Infinity;
    for (let b = firstBeat; b < lastBeat; b++) {
      const c = analysis.chordAt(b);
      const cx = x(b) + 2;
      if (c.roman !== lastRoman && cx > LABEL_W + 4 && cx - lastX > 44) {
        ctx.fillText(c.roman, cx, 33);
        lastX = cx;
      }
      lastRoman = c.roman;
    }

    // planned dynamics, keyed by note id
    const planned = new Map<number, { db: number; t0: number; t1: number }>();
    for (const g of plans) for (const n of g.notes) planned.set(n.note.id, { db: n.db, t0: n.t0, t1: n.t1 });

    // lanes and notes
    ROWS.forEach((id, row) => {
      const y0 = laneY(row);
      ctx.fillStyle = this.colors[id];
      ctx.font = '600 12px Inter, sans-serif';
      ctx.fillText(narrow ? SHORT_NAMES[id] : PERSONAS[id].role.replace(' in A', ''), narrow ? 8 : 12, y0 + laneH / 2);

      const { low, high } = analysis.tessitura[id];
      const yOf = (p: number) => y0 + laneH - 5 - ((p - low) / Math.max(1, high - low)) * (laneH - 10);
      for (const n of score.parts[id].notes) {
        if (n.start + n.dur < startBeat || n.start > startBeat + visible) continue;
        const plan = planned.get(n.id);
        const sounding = plan && time >= plan.t0 && time <= plan.t1;
        const x0 = Math.max(LABEL_W, x(n.start));
        const x1 = x(n.start + n.dur) - 1.5;
        if (x1 <= x0) continue;
        const loud = plan ? clamp((plan.db + 40) / 30, 0, 1) : 0;
        ctx.globalAlpha = plan ? 0.35 + 0.65 * loud : 0.22;
        ctx.fillStyle = this.colors[id];
        const hgt = n.marks.grace ? 2 : 3 + loud * 3;
        ctx.fillRect(x0, yOf(n.pitch) - hgt / 2, x1 - x0, hgt);
        if (sounding) {
          ctx.globalAlpha = 0.35;
          ctx.fillRect(x0, yOf(n.pitch) - 6, x1 - x0, 12);
        }
      }
      ctx.globalAlpha = 1;
    });

    // playhead
    const px = x(beat);
    const grad = ctx.createLinearGradient(px - 24, 0, px, 0);
    grad.addColorStop(0, 'rgba(217,164,65,0)');
    grad.addColorStop(1, 'rgba(217,164,65,0.12)');
    ctx.fillStyle = grad;
    ctx.fillRect(px - 24, TOP - 4, 24, h - TOP);
    ctx.strokeStyle = '#d9a441';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(px, TOP - 4);
    ctx.lineTo(px, h - 4);
    ctx.stroke();
    ctx.lineWidth = 1;
  }
}
