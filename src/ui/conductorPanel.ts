import type { EngineState, FollowInfo } from '../audio/engine';
import { BeatDetector } from '../conductor/beatDetector';
import type { Tracker } from '../conductor/handTracker';
import { clamp } from '../performance/random';

export interface ConductorHooks {
  /** A beat; `time` is on the performance.now() clock, in seconds. */
  onIctus(beat: { time: number; amplitude: number; interval: number | null }): FollowInfo | null;
  onUnitChange(unit: number): void;
  onClose(): void;
  engineState(): EngineState;
  gestureDb(): number;
}

const STORAGE_KEY = 'ensemble.conductor.v2';
const LINE = '#d9a441';

interface Saved {
  /** Height of the downbeat line, as a fraction of the image. */
  line: number;
  unit: number;
}

function load(): Saved {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null');
    if (typeof saved?.line === 'number' && saved?.unit) return saved;
  } catch {
    // storage may be unavailable
  }
  return { line: 0.7, unit: 2 };
}

function save(s: Saved): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch {
    // not essential
  }
}

/**
 * The conductor's camera: the mirrored video with a dashed downbeat line.
 * Every stroke down through the line is a beat; two beats start the
 * ensemble. The line can be dragged to where the conductor's beat lands.
 */
export class ConductorPanel {
  readonly el: HTMLElement;
  private readonly video: HTMLVideoElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly prompt: HTMLElement;
  private readonly trackerLabel: HTMLElement;
  private readonly beats: HTMLElement;
  private readonly tempo: HTMLElement;
  private readonly sync: HTMLElement;
  private readonly gesture: HTMLElement;

  private readonly detector = new BeatDetector();
  private saved = load();
  private stream: MediaStream | null = null;
  private tracker: Tracker | null = null;
  private running = false;
  private trail: { x: number; y: number; t: number }[] = [];
  private flash = 0;
  private ripple: { x: number; t: number; label: string } | null = null;
  private dragging = false;
  private lastFrameTime = 0;
  private message: string | null = null;

  constructor(private readonly hooks: ConductorHooks) {
    this.detector.line = this.saved.line;
    this.el = document.createElement('aside');
    this.el.className = 'conductor-panel';
    this.el.setAttribute('aria-label', 'Conductor mode');
    this.el.hidden = true;
    this.el.innerHTML = `
      <header class="cp-head">
        <span class="cp-live" aria-hidden="true"></span>
        <h2>Conductor</h2>
        <span class="cp-tracker">Starting camera…</span>
        <button type="button" class="cp-icon cp-min" aria-label="Minimise" title="Minimise">
          <svg viewBox="0 0 24 24"><path d="M6 12h12"/></svg>
        </button>
        <button type="button" class="cp-icon cp-close" aria-label="Close conductor mode" title="Close">
          <svg viewBox="0 0 24 24"><path d="M7 7l10 10M17 7L7 17"/></svg>
        </button>
      </header>
      <div class="cp-body">
        <div class="cp-view">
          <video playsinline muted></video>
          <canvas></canvas>
          <p class="cp-prompt"></p>
        </div>
        <div class="cp-stats">
          <div><span class="cp-label">Beat</span><span class="cp-beats"></span></div>
          <div><span class="cp-label">Tempo</span><span class="cp-value cp-tempo">—</span></div>
          <div><span class="cp-label">Ensemble</span><span class="cp-value cp-sync">—</span></div>
          <div><span class="cp-label">Gesture</span><span class="cp-gesture"><i></i></span></div>
        </div>
        <div class="cp-controls">
          <div class="mode cp-unit" role="radiogroup" aria-label="Beat pattern">
            <button type="button" role="radio" data-unit="2">In 2</button>
            <button type="button" role="radio" data-unit="1">In 4</button>
          </div>
          <p class="cp-hint">Drag the dashed line to where your beat lands.</p>
        </div>
      </div>`;

    this.video = this.el.querySelector('video')!;
    this.canvas = this.el.querySelector('canvas')!;
    this.ctx = this.canvas.getContext('2d')!;
    this.prompt = this.el.querySelector('.cp-prompt')!;
    this.trackerLabel = this.el.querySelector('.cp-tracker')!;
    this.beats = this.el.querySelector('.cp-beats')!;
    this.tempo = this.el.querySelector('.cp-tempo')!;
    this.sync = this.el.querySelector('.cp-sync')!;
    this.gesture = this.el.querySelector('.cp-gesture i')!;

    this.el.querySelector('.cp-close')!.addEventListener('click', () => this.hooks.onClose());
    this.el.querySelector('.cp-min')!.addEventListener('click', () => {
      const min = this.el.classList.toggle('minimised');
      this.el.querySelector('.cp-min')!.setAttribute('aria-label', min ? 'Expand' : 'Minimise');
    });
    this.el.querySelectorAll<HTMLButtonElement>('.cp-unit button').forEach((b) =>
      b.addEventListener('click', () => this.setUnit(Number(b.dataset.unit))),
    );
    this.setUnit(this.saved.unit);
    this.bindDragging();
  }

  get unit(): number {
    return this.saved.unit;
  }

  private setUnit(unit: number): void {
    this.saved.unit = unit;
    save(this.saved);
    this.el.querySelectorAll<HTMLButtonElement>('.cp-unit button').forEach((b) => {
      const on = Number(b.dataset.unit) === unit;
      b.classList.toggle('active', on);
      b.setAttribute('aria-checked', String(on));
    });
    const count = 4 / unit;
    this.beats.innerHTML = Array.from({ length: count }, (_, i) => `<b>${i + 1}</b>`).join('');
    this.hooks.onUnitChange(unit);
  }

  /** Open the panel and start the camera and hand tracking. */
  async open(): Promise<void> {
    this.el.hidden = false;
    this.el.classList.remove('minimised');
    this.running = true;
    this.message = 'Starting camera…';
    this.loop();
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user', frameRate: { ideal: 30 } },
        audio: false,
      });
    } catch (err) {
      this.message = cameraError(err);
      this.trackerLabel.textContent = 'No camera';
      return;
    }
    if (!this.running) return this.stopCamera();
    this.video.srcObject = this.stream;
    await this.video.play().catch(() => undefined);
    const ar = this.video.videoWidth && this.video.videoHeight ? `${this.video.videoWidth} / ${this.video.videoHeight}` : '4 / 3';
    this.el.querySelector<HTMLElement>('.cp-view')!.style.aspectRatio = ar;

    this.message = 'Loading hand tracking…';
    this.trackerLabel.textContent = 'Loading…';
    // loaded on demand, so the app stays light for those who never conduct
    const { createTracker } = await import('../conductor/handTracker');
    const prefer = new URLSearchParams(location.search).get('tracker') === 'motion' ? 'motion' : 'auto';
    const tracker = await createTracker(prefer);
    if (!this.running) return tracker.dispose();
    this.tracker = tracker;
    this.trackerLabel.textContent = tracker.label;
    this.message = null;
    this.watchFrames();
  }

  close(): void {
    this.running = false;
    this.el.hidden = true;
    this.stopCamera();
    this.tracker?.dispose();
    this.tracker = null;
    this.detector.reset();
    this.trail = [];
  }

  private stopCamera(): void {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.video.srcObject = null;
  }

  /** Run the tracker once per camera frame, timed by when it was captured. */
  private watchFrames(): void {
    const v = this.video as HTMLVideoElement & {
      requestVideoFrameCallback?: (cb: (now: number, meta: { captureTime?: number; mediaTime: number }) => void) => number;
    };
    const onFrame = (captured: number) => {
      if (!this.running || !this.tracker) return;
      if (captured === this.lastFrameTime) return;
      this.lastFrameTime = captured;
      const point = this.tracker.detect(this.video, captured);
      const t = captured / 1000;
      if (point) {
        this.trail.push({ ...point, t });
        if (this.trail.length > 40) this.trail.shift();
      }
      for (const e of this.detector.push(point, t)) {
        if (e.type === 'anticipate') {
          // only to start: the ensemble comes in with the beat it sees coming
          if (this.hooks.engineState() === 'armed') this.showFollow(this.hooks.onIctus(e));
          continue;
        }
        this.flash = 1;
        const info = this.hooks.onIctus({ time: e.time, amplitude: e.amplitude, interval: e.interval });
        this.ripple = { x: e.x, t, label: info ? String(info.beatInBar) : '' };
        this.showFollow(info);
      }
    };
    if (v.requestVideoFrameCallback) {
      const tick = (now: number, meta: { captureTime?: number }) => {
        // capture time is when the light hit the sensor: the truest beat time
        onFrame(meta.captureTime && meta.captureTime > 0 && meta.captureTime <= now ? meta.captureTime : now - 30);
        if (this.running) v.requestVideoFrameCallback!(tick);
      };
      v.requestVideoFrameCallback(tick);
    } else {
      const tick = () => {
        onFrame(performance.now() - 40);
        if (this.running) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    }
  }

  private showFollow(info: FollowInfo | null): void {
    if (!info) return;
    this.beats.querySelectorAll('b').forEach((b, i) => b.classList.toggle('on', i === info.beatInBar - 1));
    this.tempo.textContent = `♩ = ${Math.round(info.qpm)}`;
    const ms = Math.round(info.offsetMs);
    this.sync.textContent = Math.abs(ms) < 15 ? 'with you' : ms > 0 ? `${ms} ms ahead` : `${-ms} ms behind`;
  }

  // --------------------------------------------------------------- drawing

  private loop = (): void => {
    if (!this.running) return;
    this.draw();
    this.updatePrompt();
    const db = this.hooks.gestureDb();
    this.gesture.style.width = `${clamp(50 + db * 8, 4, 100)}%`;
    requestAnimationFrame(this.loop);
  };

  private updatePrompt(): void {
    let text = this.message;
    const state = this.hooks.engineState();
    if (!text) {
      if (!this.detector.position) text = 'Raise your hand into view';
      else if (state === 'armed') {
        const counting = this.detector.sinceLastBeat(performance.now() / 1000) !== null;
        text = counting ? '…and in!' : 'Beat twice through the line: we come in on the second';
      }
      else if (state === 'playing') text = null;
      else text = 'Press Get ready to conduct a new take';
    }
    this.prompt.textContent = text ?? '';
    this.prompt.classList.toggle('show', !!text);
    this.el.classList.toggle('is-armed', state === 'armed');
  }

  private draw(): void {
    const { canvas, ctx } = this;
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    if (canvas.width !== Math.round(rect.width * dpr) || canvas.height !== Math.round(rect.height * dpr)) {
      canvas.width = Math.round(rect.width * dpr);
      canvas.height = Math.round(rect.height * dpr);
    }
    const w = rect.width;
    const h = rect.height;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    if (!w || !h) return;
    const lineY = this.detector.line * h;
    const now = performance.now() / 1000;

    // the zone below the line, where each beat lands
    const g = ctx.createLinearGradient(0, lineY, 0, h);
    g.addColorStop(0, 'rgba(217,164,65,0.03)');
    g.addColorStop(1, 'rgba(217,164,65,0.26)');
    ctx.fillStyle = g;
    ctx.fillRect(0, lineY, w, h - lineY);

    this.flash = Math.max(0, this.flash - 0.05);
    this.guide(lineY, w, this.flash, this.dragging);

    // the hand and its recent path
    const trail = this.trail.filter((p) => now - p.t < 0.7);
    if (trail.length > 1) {
      ctx.lineCap = 'round';
      for (let i = 1; i < trail.length; i++) {
        const a = trail[i - 1];
        const b = trail[i];
        ctx.strokeStyle = `rgba(255,255,255,${(0.6 * i) / trail.length})`;
        ctx.lineWidth = 1 + (4 * i) / trail.length;
        ctx.beginPath();
        ctx.moveTo(a.x * w, a.y * h);
        ctx.lineTo(b.x * w, b.y * h);
        ctx.stroke();
      }
    }
    const pos = this.detector.position;
    if (pos) {
      const color = pos.y > this.detector.line ? LINE : '#ffffff';
      ctx.beginPath();
      ctx.arc(pos.x * w, pos.y * h, 9, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(13,11,16,0.55)';
      ctx.fill();
      ctx.lineWidth = 3;
      ctx.strokeStyle = color;
      ctx.stroke();
    }

    // a ripple and the beat number where the beat landed
    if (this.ripple) {
      const age = now - this.ripple.t;
      if (age > 0.8) this.ripple = null;
      else {
        const x = this.ripple.x * w;
        ctx.beginPath();
        ctx.arc(x, lineY, 10 + age * 90, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(217,164,65,${1 - age / 0.8})`;
        ctx.lineWidth = 2;
        ctx.stroke();
        if (this.ripple.label) {
          ctx.font = `600 ${Math.round(h * 0.16)}px "Cormorant Garamond", serif`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'bottom';
          ctx.fillStyle = `rgba(243,236,226,${1 - age / 0.8})`;
          ctx.fillText(this.ripple.label, x, lineY - 14);
        }
      }
    }
  }

  private guide(y: number, w: number, flash: number, active: boolean): void {
    const ctx = this.ctx;
    ctx.save();
    ctx.setLineDash([12, 9]);
    ctx.lineWidth = 2 + flash * 3 + (active ? 1 : 0);
    ctx.strokeStyle = LINE;
    ctx.shadowColor = LINE;
    ctx.shadowBlur = flash * 18;
    ctx.globalAlpha = 0.75 + 0.25 * Math.max(flash, active ? 1 : 0);
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
    ctx.stroke();
    ctx.restore();

    ctx.font = '600 10px Inter, sans-serif';
    const text = '↓ DOWNBEAT';
    const tw = ctx.measureText(text).width;
    ctx.fillStyle = 'rgba(13,11,16,0.7)';
    ctx.beginPath();
    ctx.roundRect(8, y + 6, tw + 14, 16, 8);
    ctx.fill();
    ctx.fillStyle = LINE;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, 15, y + 14.5);
  }

  /** Let the line be dragged to where the conductor's beat lands. */
  private bindDragging(): void {
    const c = this.canvas;
    const nearLine = (e: PointerEvent) => {
      const r = c.getBoundingClientRect();
      return Math.abs((e.clientY - r.top) / r.height - this.detector.line) < 18 / r.height;
    };
    c.addEventListener('pointerdown', (e) => {
      this.dragging = nearLine(e);
      if (this.dragging) {
        c.setPointerCapture(e.pointerId);
        e.preventDefault();
      }
    });
    c.addEventListener('pointermove', (e) => {
      if (!this.dragging) {
        c.style.cursor = nearLine(e) ? 'ns-resize' : 'default';
        return;
      }
      const r = c.getBoundingClientRect();
      this.detector.line = clamp((e.clientY - r.top) / r.height, 0.3, 0.92);
    });
    const end = () => {
      if (!this.dragging) return;
      this.dragging = false;
      this.saved.line = this.detector.line;
      save(this.saved);
    };
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', end);
  }
}

function cameraError(err: unknown): string {
  const name = (err as DOMException)?.name;
  if (name === 'NotAllowedError') return 'Camera permission was declined. Allow camera access for this page to conduct.';
  if (name === 'NotFoundError') return 'No camera was found.';
  if (!window.isSecureContext) return 'The camera needs a secure page (https or localhost).';
  return `The camera could not start (${name ?? 'unknown error'}).`;
}
