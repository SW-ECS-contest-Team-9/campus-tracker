import fs from 'node:fs';
import path from 'node:path';
import { defineConfig, loadEnv, type Plugin } from 'vite';

// Cesium's static runtime files (web workers, assets, widget CSS images) served at /cesium/ (CESIUM_BASE_URL):
// straight from node_modules in dev, copied into dist on build. No CDN, no Cesium ion.
const CESIUM_DIR = path.resolve(import.meta.dirname, '../node_modules/cesium/Build/Cesium');
function cesiumStatic(): Plugin {
  return {
    name: 'cesium-static',
    configureServer(server) {
      server.middlewares.use('/cesium', (req, res, next) => {
        const file = path.join(CESIUM_DIR, decodeURIComponent((req.url ?? '').split('?')[0]));
        if (!file.startsWith(CESIUM_DIR) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return next();
        const type = file.endsWith('.js') ? 'text/javascript' : file.endsWith('.json') ? 'application/json' : file.endsWith('.css') ? 'text/css' : undefined;
        if (type) res.setHeader('Content-Type', type);
        fs.createReadStream(file).pipe(res);
      });
    },
    writeBundle(options) {
      const out = path.join(options.dir ?? 'dist', 'cesium');
      for (const sub of ['Workers', 'Assets', 'ThirdParty', 'Widgets']) fs.cpSync(path.join(CESIUM_DIR, sub), path.join(out, sub), { recursive: true });
    },
  };
}

// The preview talks to the backend through this dev server (same origin): /api, /health and
// /socket.io are proxied to the backend. So there is no hard-coded backend URL in the browser code,
// the backend port comes only from PORT in the root .env, and no CORS is needed.
//
// Map engine: VITE_MAP_ENGINE=campus (default; Cesium + the campus 3D scene from the backend) or vworld (legacy).
// The VWorld loader uses document.write(), so it must be a classic synchronous <script> in index.html.
// It is injected only for the vworld engine and when VITE_VWORLD_API_KEY is set.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '..', ''); // all root .env vars (only VITE_* reach the browser)
  const backend = `http://127.0.0.1:${env.PORT || 3000}`;
  const engine = env.VITE_MAP_ENGINE?.trim() === 'vworld' ? 'vworld' : 'campus';
  const key = engine === 'vworld' ? env.VITE_VWORLD_API_KEY?.trim() : undefined;
  return {
    envDir: '..',
    build: {
      chunkSizeWarningLimit: 6000, // CesiumJS alone is ~4 MB minified (loaded lazily by campus-map.ts)
      rollupOptions: { input: { preview: path.resolve(import.meta.dirname, 'index.html'), editor: path.resolve(import.meta.dirname, 'editor.html') } },
    },
    server: {
      port: 5173,
      strictPort: true,
      proxy: {
        '/api': backend,
        '/health': backend,
        '/socket.io': { target: backend, ws: true },
      },
    },
    plugins: [
      cesiumStatic(),
      {
        name: 'vworld-loader',
        transformIndexHtml: () =>
          key
            ? [
                {
                  tag: 'script',
                  attrs: { type: 'text/javascript', src: `https://map.vworld.kr/js/webglMapInit.js.do?version=3.0&apiKey=${encodeURIComponent(key)}` },
                  injectTo: 'head',
                },
              ]
            : [],
      },
    ],
  };
});
