// Preview map without VWorld (docs/CAMPUS_3D_PREVIEW_PLAN.md): CesiumJS from npm, the server's terrain DEM as
// the ground (the same surface fusion uses for its height datum), a baked hillshade + campus/ivory texture,
// and the rough campus 3D buildings (extruded footprints) from GET /api/v1/scene.
// Scene heights are orthometric (Incheon MSL), exactly like the former VWorld scene, so trajectory.ts is unchanged.
import 'cesium/Build/Cesium/Widgets/widgets.css';
import { api, type CampusScene, type SceneBuilding, type TerrainGrid } from './api';
import { tmForward } from './tm';
import type { Viewer } from './vworld';

type CesiumNS = typeof import('cesium');
export type BuildingPick = { kind: 'building'; buildingId: string };

const COLORS = {
  background: '#eef0ec',
  outside: [214, 228, 190],
  campus: [243, 239, 224],
  wall: '#e6e4df',
  estimate: '#ece2c9',
  selected: '#93c5fd',
  edge: '#a8a29e',
  label: '#374151',
};

/** Bilinear height at an EPSG:5186 point; outside the grid the nearest edge value (no cliff at the border). */
function sampler(g: TerrainGrid) {
  return (x: number, y: number): number => {
    let fx = (x - g.originX) / g.resolution - 0.5;
    let fy = (y - g.originY) / g.resolution - 0.5;
    if (!Number.isFinite(fx) || !Number.isFinite(fy)) return g.heights[0];
    fx = Math.min(Math.max(fx, 0), g.width - 1.001);
    fy = Math.min(Math.max(fy, 0), g.height - 1.001);
    const ix = Math.floor(fx);
    const iy = Math.floor(fy);
    const tx = fx - ix;
    const ty = fy - iy;
    const h = (i: number, j: number) => g.heights[j * g.width + i];
    return h(ix, iy) * (1 - tx) * (1 - ty) + h(ix + 1, iy) * tx * (1 - ty) + h(ix, iy + 1) * (1 - tx) * ty + h(ix + 1, iy + 1) * tx * ty;
  };
}

function ringContains(x: number, y: number, ring: number[][]) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Separable box blur of a grid (edges clamped). */
function boxBlur(src: Float32Array, w: number, h: number, r: number): Float32Array {
  const tmp = new Float32Array(src.length);
  const out = new Float32Array(src.length);
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      let sum = 0;
      for (let k = -r; k <= r; k++) sum += src[j * w + Math.min(Math.max(i + k, 0), w - 1)];
      tmp[j * w + i] = sum / (2 * r + 1);
    }
  }
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      let sum = 0;
      for (let k = -r; k <= r; k++) sum += tmp[Math.min(Math.max(j + k, 0), h - 1) * w + i];
      out[j * w + i] = sum / (2 * r + 1);
    }
  }
  return out;
}

/** Ground texture: campus ivory / surroundings green, multiplied by a hillshade of the DEM (light from the NW). */
function groundTexture(g: TerrainGrid, campus: CampusScene['campus']): string {
  const W = g.width * 2;
  const H = g.height * 2;
  // hillshade and campus mask per DEM cell
  const shade = new Float32Array(g.width * g.height);
  const inCampus = new Uint8Array(g.width * g.height);
  const rings = campus.flatMap((m) => m.coordinates.map((poly) => poly[0].map(([lon, lat]) => { const p = tmForward(lat, lon); return [p.x, p.y]; })));
  const az = (315 * Math.PI) / 180;
  const alt = (45 * Math.PI) / 180;
  // shading only: a smoothed copy, otherwise the slope kinks at every contour line (the DEM is linear between
  // contours) show up as terraces. The terrain geometry itself keeps the DEM heights.
  const smooth = boxBlur(boxBlur(g.heights, g.width, g.height, 3), g.width, g.height, 3);
  for (let j = 0; j < g.height; j++) {
    for (let i = 0; i < g.width; i++) {
      const h = (a: number, b: number) => smooth[Math.min(Math.max(b, 0), g.height - 1) * g.width + Math.min(Math.max(a, 0), g.width - 1)];
      const dzdx = (h(i + 1, j) - h(i - 1, j)) / (2 * g.resolution);
      const dzdy = (h(i, j + 1) - h(i, j - 1)) / (2 * g.resolution);
      const slope = Math.atan(Math.hypot(dzdx, dzdy));
      const aspect = Math.atan2(-dzdx, -dzdy); // direction the slope faces (0 = north, clockwise)
      shade[j * g.width + i] = Math.max(0, Math.cos(alt) * Math.cos(slope) + Math.sin(alt) * Math.sin(slope) * Math.cos(az - aspect));
      const x = g.originX + (i + 0.5) * g.resolution;
      const y = g.originY + (j + 0.5) * g.resolution;
      inCampus[j * g.width + i] = rings.some((r) => ringContains(x, y, r)) ? 1 : 0;
    }
  }
  const flat = Math.cos(alt); // shade of flat ground: keep flat areas at their base color
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d')!;
  const img = ctx.createImageData(W, H);
  const b = g.bounds;
  for (let py = 0; py < H; py++) {
    const lat = b.north - ((py + 0.5) / H) * (b.north - b.south);
    for (let px = 0; px < W; px++) {
      const lon = b.west + ((px + 0.5) / W) * (b.east - b.west);
      const p = tmForward(lat, lon);
      const i = Math.floor((p.x - g.originX) / g.resolution);
      const j = Math.floor((p.y - g.originY) / g.resolution);
      const k = (py * W + px) * 4;
      if (i < 0 || j < 0 || i >= g.width || j >= g.height) {
        img.data[k + 3] = 0;
        continue;
      }
      const c = inCampus[j * g.width + i] ? COLORS.campus : COLORS.outside;
      const f = Math.min(1.06, Math.max(0.72, 0.55 + 0.45 * (shade[j * g.width + i] / flat)));
      img.data[k] = Math.min(255, c[0] * f);
      img.data[k + 1] = Math.min(255, c[1] * f);
      img.data[k + 2] = Math.min(255, c[2] * f);
      img.data[k + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvas.toDataURL('image/png');
}

/** Heightmap terrain from the DEM grid (heights = orthometric, like the former VWorld scene). */
function terrainProvider(C: CesiumNS, g: TerrainGrid) {
  const at = sampler(g);
  const N = 33;
  const b = g.bounds;
  const margin = 0.005;
  const provider: any = new C.CustomHeightmapTerrainProvider({
    width: N,
    height: N,
    callback: (x: number, y: number, level: number) => {
      const r = provider.tilingScheme.tileXYToRectangle(x, y, level);
      const west = C.Math.toDegrees(r.west), east = C.Math.toDegrees(r.east), south = C.Math.toDegrees(r.south), north = C.Math.toDegrees(r.north);
      const out = new Float32Array(N * N);
      if (east < b.west - margin || west > b.east + margin || north < b.south - margin || south > b.north + margin) {
        // far from the campus: one constant (the nearest edge height) keeps distant tiles flat and cheap
        const lat = Math.min(Math.max((south + north) / 2, b.south), b.north);
        const lon = Math.min(Math.max((west + east) / 2, b.west), b.east);
        const p = tmForward(lat, lon);
        out.fill(at(p.x, p.y));
        return out;
      }
      for (let j = 0; j < N; j++) {
        const lat = north - (j / (N - 1)) * (north - south); // row 0 = north
        for (let i = 0; i < N; i++) {
          const p = tmForward(lat, west + (i / (N - 1)) * (east - west));
          out[j * N + i] = at(p.x, p.y);
        }
      }
      return out;
    },
  });
  return provider;
}

/** The campus buildings: one batched primitive (extruded footprints), roof/corner edges and name labels. */
export class CampusSceneLayer {
  private primitive: any = null;
  private edges: any;
  private labels: any;
  private opacity = 1;
  private showEstimate = true;
  private selected: string | null = null;
  readonly picks = new Map<string, BuildingPick>();

  constructor(private readonly C: CesiumNS, private readonly viewer: any, readonly scene: CampusScene) {
    this.edges = viewer.scene.primitives.add(new C.PolylineCollection());
    this.labels = viewer.scene.primitives.add(new C.LabelCollection());
    for (const b of scene.buildings) this.picks.set(b.buildingId, { kind: 'building', buildingId: b.buildingId });
    this.drawEdgesAndLabels();
    this.rebuild();
  }

  building(id: string): SceneBuilding | undefined {
    return this.scene.buildings.find((b) => b.buildingId === id);
  }

  setOpacity(opacity: number) {
    this.opacity = opacity;
    this.rebuild();
  }

  setShowEstimate(show: boolean) {
    this.showEstimate = show;
    this.rebuild();
  }

  setShowLabels(show: boolean) {
    this.labels.show = show;
  }

  select(buildingId: string | null) {
    if (this.selected === buildingId) return;
    this.selected = buildingId;
    this.rebuild();
  }

  /** Whole campus, oblique. */
  home(duration = 1.2) {
    const C = this.C;
    const pts = this.scene.buildings.flatMap((b) => b.geometry.coordinates.flatMap((poly) => poly[0].map(([lon, lat]) => C.Cartesian3.fromDegrees(lon, lat, b.roofM))));
    if (!pts.length) return;
    const sphere = C.BoundingSphere.fromPoints(pts);
    this.viewer.camera.flyToBoundingSphere(sphere, { duration, offset: new C.HeadingPitchRange(C.Math.toRadians(-20), C.Math.toRadians(-38), sphere.radius * 2.4) });
  }

  /** Straight down over the campus. */
  top() {
    const C = this.C;
    const pts = this.scene.buildings.flatMap((b) => b.geometry.coordinates.flatMap((poly) => poly[0].map(([lon, lat]) => C.Cartesian3.fromDegrees(lon, lat, b.roofM))));
    const sphere = C.BoundingSphere.fromPoints(pts);
    this.viewer.camera.flyToBoundingSphere(sphere, { duration: 1, offset: new C.HeadingPitchRange(0, C.Math.toRadians(-89.9), sphere.radius * 3) });
  }

  flyToBuilding(id: string) {
    const b = this.building(id);
    if (!b) return;
    const C = this.C;
    const pts = b.geometry.coordinates.flatMap((poly) => poly[0].map(([lon, lat]) => C.Cartesian3.fromDegrees(lon, lat, (b.baseM + b.roofM) / 2)));
    const sphere = C.BoundingSphere.fromPoints(pts);
    this.viewer.camera.flyToBoundingSphere(sphere, { duration: 1, offset: new C.HeadingPitchRange(C.Math.toRadians(-20), C.Math.toRadians(-35), Math.max(sphere.radius * 3, 80)) });
  }

  private rebuild() {
    const C = this.C;
    const instances: any[] = [];
    for (const b of this.scene.buildings) {
      const css = b.buildingId === this.selected ? COLORS.selected : this.showEstimate && b.heightSource !== 'REGISTER' ? COLORS.estimate : COLORS.wall;
      const color = C.Color.fromCssColorString(css).withAlpha(this.opacity);
      for (const poly of b.geometry.coordinates) {
        const ring = (r: number[][]) => C.Cartesian3.fromDegreesArray(r.slice(0, -1).flat());
        instances.push(new C.GeometryInstance({
          geometry: new C.PolygonGeometry({
            polygonHierarchy: new C.PolygonHierarchy(ring(poly[0]), poly.slice(1).map((h) => new C.PolygonHierarchy(ring(h)))),
            height: b.baseM,
            extrudedHeight: b.roofM,
            vertexFormat: C.PerInstanceColorAppearance.VERTEX_FORMAT,
          }),
          id: this.picks.get(b.buildingId),
          attributes: { color: C.ColorGeometryInstanceAttribute.fromColor(color) },
        }));
      }
    }
    const next = new C.Primitive({
      geometryInstances: instances,
      appearance: new C.PerInstanceColorAppearance({ translucent: this.opacity < 1, closed: true }),
      asynchronous: false,
    });
    if (this.primitive) this.viewer.scene.primitives.remove(this.primitive);
    this.primitive = this.viewer.scene.primitives.add(next);
  }

  private drawEdgesAndLabels() {
    const C = this.C;
    const edge = C.Material.fromType('Color', { color: C.Color.fromCssColorString(COLORS.edge) });
    for (const b of this.scene.buildings) {
      let best: number[][] = [];
      for (const poly of b.geometry.coordinates) {
        const r = poly[0];
        if (r.length > best.length) best = r;
        // roof outline, slightly above the roof so it is not z-fighting
        this.edges.add({ positions: C.Cartesian3.fromDegreesArrayHeights(r.flatMap(([lon, lat]) => [lon, lat, b.roofM + 0.05])), width: 1.5, material: edge, id: this.picks.get(b.buildingId) });
        // vertical edges only at real corners (not along curved walls)
        const open = r.slice(0, -1);
        for (let i = 0; i < open.length; i++) {
          const p = open[(i + open.length - 1) % open.length];
          const c = open[i];
          const n = open[(i + 1) % open.length];
          const a1 = Math.atan2(c[1] - p[1], (c[0] - p[0]) * Math.cos((c[1] * Math.PI) / 180));
          const a2 = Math.atan2(n[1] - c[1], (n[0] - c[0]) * Math.cos((c[1] * Math.PI) / 180));
          let turn = Math.abs(a2 - a1);
          if (turn > Math.PI) turn = 2 * Math.PI - turn;
          if (turn < (35 * Math.PI) / 180) continue;
          this.edges.add({ positions: C.Cartesian3.fromDegreesArrayHeights([c[0], c[1], b.baseM, c[0], c[1], b.roofM + 0.05]), width: 1, material: edge, id: this.picks.get(b.buildingId) });
        }
      }
      if (!b.name || !best.length) continue;
      const open = best.slice(0, -1);
      const lon = open.reduce((s, p) => s + p[0], 0) / open.length;
      const lat = open.reduce((s, p) => s + p[1], 0) / open.length;
      this.labels.add({
        position: C.Cartesian3.fromDegrees(lon, lat, b.roofM + 2),
        text: b.name,
        font: '600 13px system-ui, "Apple SD Gothic Neo", sans-serif',
        fillColor: C.Color.fromCssColorString(COLORS.label),
        outlineColor: C.Color.WHITE,
        outlineWidth: 3,
        style: C.LabelStyle.FILL_AND_OUTLINE,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
        scaleByDistance: new C.NearFarScalar(200, 1, 2500, 0.6),
        id: this.picks.get(b.buildingId),
      });
    }
  }
}

/**
 * Creates the Cesium viewer with the campus terrain and 3D scene. Resolves like initVWorld (the viewer) plus the
 * building layer; without an imported scene the ground still works and `scene` is null.
 */
export async function initCampusMap(containerId: string): Promise<{ viewer: Viewer; scene: CampusSceneLayer | null; warning: string | null }> {
  (window as any).CESIUM_BASE_URL = '/cesium/';
  const C: CesiumNS = await import('cesium');
  (window as any).Cesium = C; // trajectory.ts / lab.ts use the global namespace (as with VWorld)
  const [grid, sceneData] = await Promise.all([api.terrainGrid(), api.scene().catch((err: Error) => err)]);
  const viewer: any = new C.Viewer(containerId, {
    baseLayer: false,
    terrainProvider: terrainProvider(C, grid),
    animation: false,
    timeline: false,
    baseLayerPicker: false,
    geocoder: false,
    homeButton: false,
    sceneModePicker: false,
    navigationHelpButton: false,
    fullscreenButton: false,
    infoBox: false,
    selectionIndicator: false,
    scene3DOnly: true,
    requestRenderMode: false,
  });
  const scene = viewer.scene;
  scene.skyBox.show = false;
  scene.skyAtmosphere.show = false;
  scene.sun.show = false;
  scene.moon.show = false;
  scene.fog.enabled = false;
  scene.backgroundColor = C.Color.fromCssColorString(COLORS.background);
  scene.globe.baseColor = C.Color.fromCssColorString(`rgb(${COLORS.outside.join(',')})`);
  scene.globe.showGroundAtmosphere = false;
  scene.globe.enableLighting = false; // the ground texture carries its own hillshade
  scene.globe.depthTestAgainstTerrain = true; // as in the VWorld scene
  viewer.cesiumWidget.creditContainer.style.display = 'none';

  // fixed soft light from the south-west, so walls are shaded the same way at any time of day
  const center = C.Cartesian3.fromDegrees((grid.bounds.west + grid.bounds.east) / 2, (grid.bounds.south + grid.bounds.north) / 2, 0);
  const enu = C.Transforms.eastNorthUpToFixedFrame(center);
  const dir = C.Matrix4.multiplyByPointAsVector(enu, new C.Cartesian3(0.55, 0.65, -0.75), new C.Cartesian3());
  scene.light = new C.DirectionalLight({ direction: C.Cartesian3.normalize(dir, dir), intensity: 2.2 });

  const campus = sceneData instanceof Error ? [] : sceneData.campus;
  viewer.imageryLayers.addImageryProvider(
    await C.SingleTileImageryProvider.fromUrl(groundTexture(grid, campus), {
      rectangle: C.Rectangle.fromDegrees(grid.bounds.west, grid.bounds.south, grid.bounds.east, grid.bounds.north),
    }),
  );
  for (const m of campus) {
    for (const poly of m.coordinates) {
      viewer.entities.add({ polyline: { positions: C.Cartesian3.fromDegreesArray(poly[0].flat()), width: 2, clampToGround: true, material: C.Color.fromCssColorString('#b3ae94') } });
    }
  }
  if (sceneData instanceof Error) {
    viewer.camera.setView({ destination: C.Rectangle.fromDegrees(grid.bounds.west, grid.bounds.south, grid.bounds.east, grid.bounds.north) });
    return { viewer, scene: null, warning: `Campus 3D buildings unavailable: ${sceneData.message} (npm run scene:import)` };
  }
  const layer = new CampusSceneLayer(C, viewer, sceneData);
  layer.home(0);
  return { viewer, scene: layer, warning: null };
}
