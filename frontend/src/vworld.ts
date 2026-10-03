// VWorld WebGL 3D API 3.0 bootstrap.
// The loader script in index.html defines `vw`; after map.start() VWorld exposes its internal
// Cesium viewer as `ws3d.viewer` and the Cesium namespace as global `Cesium`.
// Reference: official samples github.com/V-world/V-world_API_sample ([WebGL3] *.html).

declare global {
  interface Window {
    vw?: any;
    ws3d?: any;
    Cesium?: any;
  }
}

export type Viewer = any;

/** Initial camera: Seoul, top-down. Overridden by flyTo once data arrives. */
const INIT = { lon: 126.978, lat: 37.5665, height: 3000 };

export function initVWorld(containerId: string): Promise<Viewer> {
  const vw = window.vw;
  if (!import.meta.env.VITE_VWORLD_API_KEY) {
    return Promise.reject(new Error('VITE_VWORLD_API_KEY is empty. Set it in the root .env and restart `npm run dev`.'));
  }
  if (!vw) {
    return Promise.reject(new Error('VWorld script did not load (network blocked or invalid key/domain).'));
  }

  const map = new vw.Map();
  map.setOption({
    mapId: containerId,
    initPosition: new vw.CameraPosition(new vw.CoordZ(INIT.lon, INIT.lat, INIT.height), new vw.Direction(0, -90, 0)),
    logo: true,
    navigation: true,
  });
  map.start();

  return new Promise((resolve, reject) => {
    let done = false;
    const finish = () => {
      const viewer = window.ws3d?.viewer;
      if (done || !viewer || !window.Cesium) return false;
      done = true;
      resolve(viewer);
      return true;
    };
    // Official ready hook...
    const prev = vw.ws3dInitCallBack;
    vw.ws3dInitCallBack = (...a: unknown[]) => {
      prev?.(...a);
      finish();
    };
    // ...plus polling, since some VWorld builds create ws3d.viewer synchronously in start().
    const started = Date.now();
    const timer = setInterval(() => {
      if (finish() || done) clearInterval(timer);
      else if (Date.now() - started > 30_000) {
        clearInterval(timer);
        reject(new Error('VWorld viewer was not ready after 30 s. Check the API key and that its service URL includes this origin.'));
      }
    }, 200);
  });
}
