import fs from 'node:fs';
import path from 'node:path';
import { defineConfig, type Plugin } from 'vite';

const MEDIAPIPE_WASM = path.resolve(__dirname, 'node_modules/@mediapipe/tasks-vision/wasm');

/** Serve MediaPipe's WASM runtime from the app itself rather than a CDN. */
function mediapipeWasm(): Plugin {
  return {
    name: 'mediapipe-wasm',
    configureServer(server) {
      server.middlewares.use('/mediapipe/wasm', (req, res, next) => {
        const file = path.join(MEDIAPIPE_WASM, path.basename((req.url ?? '').split('?')[0]));
        if (!fs.existsSync(file)) return next();
        res.setHeader('Content-Type', file.endsWith('.wasm') ? 'application/wasm' : 'text/javascript');
        fs.createReadStream(file).pipe(res);
      });
    },
    generateBundle() {
      if (process.env.VITE_CAMERA === 'off') return; // no conductor mode, no runtime
      // the classic (non-module) runtime, with and without SIMD
      for (const name of fs.readdirSync(MEDIAPIPE_WASM).filter((n) => !n.includes('_module_'))) {
        this.emitFile({ type: 'asset', fileName: `mediapipe/wasm/${name}`, source: fs.readFileSync(path.join(MEDIAPIPE_WASM, name)) });
      }
    },
  };
}

export default defineConfig({
  base: './',
  plugins: [mediapipeWasm()],
});
