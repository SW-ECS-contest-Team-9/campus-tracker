import { defineConfig, loadEnv } from 'vite';

// The preview talks to the backend through this dev server (same origin): /api, /health and
// /socket.io are proxied to the backend. So there is no hard-coded backend URL in the browser code,
// the backend port comes only from PORT in the root .env, and no CORS is needed.
//
// The VWorld loader uses document.write(), so it must be a classic synchronous <script> in index.html.
// It is injected here only when VITE_VWORLD_API_KEY is set.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '..', ''); // all root .env vars (only VITE_* reach the browser)
  const backend = `http://127.0.0.1:${env.PORT || 3000}`;
  const key = env.VITE_VWORLD_API_KEY?.trim();
  return {
    envDir: '..',
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
