import type { PartSnapshot } from '../audio/engine';
import { PERSONAS } from '../performance/personas';
import { clamp } from '../performance/random';
import { PART_IDS, type PartId } from '../score/score';
import { noteName } from '../theory/pitch';
import { instrumentSvg } from './instruments';

const DYNAMIC_LABELS: [number, string][] = [
  [-31, 'ppp'], [-26, 'pp'], [-20.5, 'p'], [-16, 'mp'], [-11.5, 'mf'], [-7, 'f'], [Infinity, 'ff'],
];

const dynamicLabel = (db: number) => DYNAMIC_LABELS.find(([limit]) => db < limit)![1];

interface Station {
  root: HTMLElement;
  instrument: HTMLElement;
  bow: SVGGElement | null;
  note: HTMLElement;
  dynamic: HTMLElement;
  vibrato: HTMLCanvasElement;
  role: HTMLElement;
  intent: HTMLElement;
  phase: number;
  shownIntent: string | null;
}

export class Stage {
  private stations = new Map<PartId, Station>();
  private lastTime = 0;

  constructor(root: HTMLElement) {
    for (const id of PART_IDS) {
      const p = PERSONAS[id];
      const el = document.createElement('div');
      el.className = 'station';
      el.dataset.part = id;
      el.title = p.style;
      el.innerHTML = `
        <div class="spot"></div>
        <div class="instrument">${instrumentSvg(p.instrument, id)}</div>
        <div class="nameplate"><div class="name">${p.name}</div><div class="role">${p.role}</div></div>
        <div class="live">
          <span class="label">Note</span><span class="value note-value">—</span>
          <span class="label">Dynamic</span><span class="value dyn-value">—</span>
          <div class="meter" style="grid-column: 1 / -1"><i></i></div>
          <span class="label">${p.vibratoDepth ? 'Vibrato' : 'Breath'}</span><canvas class="vibrato" width="220" height="44"></canvas>
          <span class="label">Role</span><span class="badge" data-role="rest">tacet</span>
        </div>
        <p class="intent"></p>`;
      root.appendChild(el);
      this.stations.set(id, {
        root: el,
        instrument: el.querySelector('.instrument')!,
        bow: el.querySelector<SVGGElement>('.bow'),
        note: el.querySelector('.note-value')!,
        dynamic: el.querySelector('.dyn-value')!,
        vibrato: el.querySelector('.vibrato')!,
        role: el.querySelector('.badge')!,
        intent: el.querySelector('.intent')!,
        phase: Math.random() * 10,
        shownIntent: null,
      });
    }
  }

  update(time: number, snapshots: Record<PartId, PartSnapshot>, playing: boolean): void {
    const dt = clamp(time - this.lastTime, 0, 0.1);
    this.lastTime = time;
    for (const id of PART_IDS) {
      const s = this.stations.get(id)!;
      const snap = snapshots[id];
      const intensity = playing ? clamp((snap.db + 46) / 36, 0, 1) : 0;
      s.root.style.setProperty('--intensity', intensity.toFixed(3));

      // the player moves with the music: a gentle sway that grows with intensity
      const sway = Math.sin(time * 1.3 + s.phase) * (1 + 3 * intensity);
      const lift = -6 * intensity;
      s.instrument.style.transform = `translateY(${lift.toFixed(1)}px) rotate(${sway.toFixed(2)}deg)`;

      if (s.bow) {
        const g = snap.gesture;
        let x = 0;
        if (g && playing) {
          const progress = clamp((time - g.start) / Math.max(0.05, g.end - g.start), 0, 1);
          x = (progress - 0.5) * 70 * (g.stroke % 2 ? -1 : 1);
        }
        s.bow.setAttribute('transform', `translate(${x.toFixed(1)} 0)`);
        s.bow.style.opacity = g && playing ? '1' : '0.35';
      }

      const note = playing ? snap.note : null;
      if (note) {
        const cents = Math.round((note.pitch - Math.round(note.pitch)) * 100);
        const tune = Math.abs(cents) >= 3 ? ` <small>${cents > 0 ? '+' : '−'}${Math.abs(cents)}¢</small>` : '';
        s.note.innerHTML = noteName(note.pitch) + tune;
        s.dynamic.textContent = dynamicLabel(snap.db);
      } else {
        s.note.textContent = '—';
        s.dynamic.textContent = '—';
      }

      const role = note?.role ?? (playing ? 'rest' : 'rest');
      s.role.dataset.role = role;
      s.role.textContent = role === 'rest' ? 'tacet' : role;
      s.role.title = role === 'counter' ? 'Countermelody' : '';

      this.drawVibrato(s, playing ? snap.vibratoCents : 0, intensity, dt, id === 'clarinet');

      const showIntent = playing && snap.intent && snap.intentAge < 3.2;
      if (showIntent && snap.intent !== s.shownIntent) {
        s.intent.textContent = snap.intent;
        s.shownIntent = snap.intent;
      }
      s.intent.classList.toggle('show', !!showIntent);
    }
  }

  private drawVibrato(s: Station, cents: number, intensity: number, dt: number, breath: boolean): void {
    const c = s.vibrato;
    const ctx = c.getContext('2d')!;
    const { width: w, height: h } = c;
    ctx.clearRect(0, 0, w, h);
    const hue = getComputedStyle(s.root).getPropertyValue('--hue').trim() || '#d9a441';
    // strings: the vibrato wave; clarinet: the breath pressure (no vibrato)
    const amp = breath ? 0 : clamp(cents / 22, 0, 1) * (h / 2 - 3);
    s.phase += dt * (breath ? 1 : 5.8) * Math.PI * 2;
    ctx.lineWidth = 2;
    ctx.strokeStyle = hue;
    ctx.globalAlpha = 0.35 + 0.65 * intensity;
    ctx.beginPath();
    for (let x = 0; x <= w; x += 2) {
      const y = breath
        ? h - 4 - intensity * (h - 8) * (0.92 + 0.08 * Math.sin(s.phase * 0.7 + x * 0.03))
        : h / 2 + Math.sin(s.phase - x * 0.09) * amp;
      if (x === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.globalAlpha = 1;
    if (!breath && amp > 0.5) {
      ctx.font = '600 18px Inter, sans-serif';
      ctx.textAlign = 'right';
      ctx.textBaseline = 'top';
      ctx.fillStyle = 'rgba(243,236,226,0.75)';
      ctx.fillText(`±${Math.round(cents)}¢`, w, 0);
    }
  }
}
