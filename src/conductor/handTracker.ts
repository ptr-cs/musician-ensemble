import { FilesetResolver, HandLandmarker, type NormalizedLandmark } from '@mediapipe/tasks-vision';

/** A tracked conducting hand, in mirrored image coordinates (0..1, 0 = top). */
export interface HandPoint {
  x: number;
  y: number;
}

export interface Tracker {
  readonly kind: 'hand' | 'motion';
  readonly label: string;
  detect(video: HTMLVideoElement, timeMs: number): HandPoint | null;
  dispose(): void;
}

const WASM_BASE = `${import.meta.env.BASE_URL}mediapipe/wasm`;
const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';
const LOAD_TIMEOUT_MS = 15000;

/** Palm centre: the wrist and the four knuckles are steadier than fingertips. */
const PALM = [0, 5, 9, 13, 17];

/** MediaPipe hand landmarks: follows the hand itself, even against a busy background. */
class LandmarkTracker implements Tracker {
  readonly kind = 'hand';
  readonly label = 'Hand tracking';
  private last: HandPoint | null = null;
  private lastTimestamp = -1;

  constructor(private readonly landmarker: HandLandmarker) {}

  detect(video: HTMLVideoElement, timeMs: number): HandPoint | null {
    // the task requires strictly increasing timestamps
    const ts = Math.max(timeMs, this.lastTimestamp + 1);
    this.lastTimestamp = ts;
    const result = this.landmarker.detectForVideo(video, ts);
    const hands = result.landmarks.map((lm: NormalizedLandmark[]) => {
      const x = PALM.reduce((s, i) => s + lm[i].x, 0) / PALM.length;
      const y = PALM.reduce((s, i) => s + lm[i].y, 0) / PALM.length;
      return { x: 1 - x, y }; // mirror, as the user sees themselves
    });
    if (!hands.length) return (this.last = null);
    // with two hands in view, stay with the one we were following
    const prev = this.last;
    const pick = prev
      ? hands.reduce((a, b) => (Math.hypot(a.x - prev.x, a.y - prev.y) <= Math.hypot(b.x - prev.x, b.y - prev.y) ? a : b))
      : hands.reduce((a, b) => (a.y <= b.y ? a : b)); // otherwise the raised one
    return (this.last = pick);
  }

  dispose(): void {
    this.landmarker.close();
  }
}

/**
 * Fallback when the hand model can't be loaded (e.g. offline): the centroid
 * of what moved between frames. Works when the conducting hand is the main
 * thing moving in the picture.
 */
class MotionTracker implements Tracker {
  readonly kind = 'motion';
  readonly label = 'Motion tracking';
  private readonly canvas = document.createElement('canvas');
  private readonly ctx: CanvasRenderingContext2D;
  private previous: Float32Array | null = null;
  private last: { point: HandPoint; at: number } | null = null;
  private readonly w = 96;
  private readonly h = 72;

  constructor() {
    this.canvas.width = this.w;
    this.canvas.height = this.h;
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true })!;
  }

  detect(video: HTMLVideoElement, timeMs: number): HandPoint | null {
    const { w, h, ctx } = this;
    ctx.drawImage(video, 0, 0, w, h);
    const data = ctx.getImageData(0, 0, w, h).data;
    const gray = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) gray[i] = 0.3 * data[i * 4] + 0.59 * data[i * 4 + 1] + 0.11 * data[i * 4 + 2];
    const prev = this.previous;
    this.previous = gray;
    if (!prev) return null;

    let count = 0, sx = 0, sy = 0;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const d = Math.abs(gray[y * w + x] - prev[y * w + x]);
        if (d > 26) {
          count += d;
          sx += x * d;
          sy += y * d;
        }
      }
    }
    if (count < 26 * 18) {
      // a still hand makes no motion: assume it is where it stopped, briefly
      return this.last && timeMs - this.last.at < 1500 ? this.last.point : null;
    }
    const point = { x: 1 - sx / count / w, y: sy / count / h };
    this.last = { point, at: timeMs };
    return point;
  }

  dispose(): void {
    this.previous = null;
    this.last = null;
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([promise, new Promise<T>((_, reject) => setTimeout(() => reject(new Error('timed out')), ms))]);
}

/** The best tracker available: hand landmarks (GPU, then CPU), else motion. */
export async function createTracker(prefer: 'auto' | 'motion' = 'auto'): Promise<Tracker> {
  if (prefer === 'motion') return new MotionTracker();
  try {
    const fileset = await withTimeout(FilesetResolver.forVisionTasks(WASM_BASE), LOAD_TIMEOUT_MS);
    for (const delegate of ['GPU', 'CPU'] as const) {
      try {
        const landmarker = await withTimeout(
          HandLandmarker.createFromOptions(fileset, {
            baseOptions: { modelAssetPath: MODEL_URL, delegate },
            runningMode: 'VIDEO',
            numHands: 2,
            minHandDetectionConfidence: 0.5,
            minHandPresenceConfidence: 0.5,
            minTrackingConfidence: 0.4,
          }),
          LOAD_TIMEOUT_MS,
        );
        return new LandmarkTracker(landmarker);
      } catch (err) {
        console.warn(`Hand tracking (${delegate}) unavailable:`, err);
      }
    }
  } catch (err) {
    console.warn('Hand tracking unavailable, using motion tracking:', err);
  }
  return new MotionTracker();
}
