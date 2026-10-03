// Terrain (DEM) building blocks and the fusion-v4 terrain datum.  npm test -w backend
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmForward } from '../src/geo/tm.js';
import { distanceTransform } from '../src/geo/edt.js';
import { bilinear, buildDem, type Grid } from '../src/geo/dem.js';
import { terrain, type TerrainContext } from '../src/geo/terrain.js';
import { localToWgs84 } from '../src/geo/local-to-wgs84.js';
import { compareObservations, type Observation } from '../src/modules/fusion/fusion.timeline.js';
import { finalizeFusionV4, processObservationV4 } from '../src/modules/fusion/fusion-v4.engine.js';
import { createFusionStateV4 } from '../src/modules/fusion/fusion-state-v4.js';
import { fusionConfigV4 as cfg } from '../src/modules/fusion/fusion.config.js';

test('TM forward matches PostGIS EPSG:5186 within 1 cm', () => {
  // reference values from PostGIS ST_Transform(4326 -> 5186)
  const ref: [number, number, number, number][] = [
    [37.61500445350227, 127.01264376659661, 201116.3137220434, 557268.3267747858],
    [37.62, 127.0, 200000, 557822.7035618249],
    [37.61, 127.03, 202648.86701014065, 556713.2347360994],
    [37.5665, 126.978, 198056.36673702704, 551885.0305887164],
  ];
  for (const [lat, lon, x, y] of ref) {
    const p = tmForward(lat, lon);
    assert.ok(Math.hypot(p.x - x, p.y - y) < 0.01, `${lat},${lon}: off by ${Math.hypot(p.x - x, p.y - y)} m`);
  }
});

test('distance transform: exact Euclidean distances to a feature cell', () => {
  const w = 7, h = 5;
  const mask = new Uint8Array(w * h);
  mask[2 * w + 3] = 1;
  const d = distanceTransform(mask, w, h);
  assert.equal(d[2 * w + 3], 0);
  assert.ok(Math.abs(d[0] - Math.hypot(3, 2)) < 1e-6);
  assert.ok(Math.abs(d[4 * w + 6] - Math.hypot(3, 2)) < 1e-6);
});

test('DEM from contours of a plane is the plane (linear between levels)', () => {
  // z = 100 + 0.1 * x, contours every 5 m (every 50 m in x)
  const grid: Grid = { originX: 0, originY: 0, resolution: 2, width: 151, height: 51 };
  const contours = [0, 50, 100, 150, 200, 250, 300].map((x) => ({ height: 100 + 0.1 * x, points: [[x, -10], [x, 120]] as [number, number][] }));
  const dem = buildDem(grid, contours, []);
  for (const x of [25, 75, 130, 210]) {
    const h = bilinear(grid, dem.heights, x, 50)!;
    assert.ok(Math.abs(h - (100 + 0.1 * x)) < 0.3, `x=${x}: ${h}`);
  }
});

// ---- fusion-v4 with a terrain context ----
const ORIGIN = { latitude: 37.6158, longitude: 127.0118, height: 0 };
const T0 = Date.parse('2026-10-02T06:00:00.000Z');
function rng(seed: number) {
  let s = seed >>> 0;
  const u = () => ((s = (1664525 * s + 1013904223) >>> 0) + 0.5) / 2 ** 32;
  return () => Math.sqrt(-2 * Math.log(u())) * Math.cos(2 * Math.PI * u());
}

/** Synthetic DEM around ORIGIN rising 5 % to the north: H = 100 + 0.05 * (northing - northing(ORIGIN)). */
function slopeTerrain(): TerrainContext {
  const o = tmForward(ORIGIN.latitude, ORIGIN.longitude);
  const grid: Grid = { originX: o.x - 300, originY: o.y - 300, resolution: 2, width: 300, height: 300 };
  const heights = new Float32Array(grid.width * grid.height);
  for (let iy = 0; iy < grid.height; iy++) {
    for (let ix = 0; ix < grid.width; ix++) heights[iy * grid.width + ix] = 100 + 0.05 * (grid.originY + (iy + 0.5) * grid.resolution - o.y);
  }
  return { versionId: 'test', grid, heights, sigma: new Float32Array(heights.length).fill(0.5), modified: new Uint8Array(heights.length), geoidSeparation: 23.38, buildings: [] };
}

/** Walk north (then east) 2 steps/s; the barometer follows the ground: relative Z = 0.05 * y (+ optional drift). */
function walk(ctx: TerrainContext, seconds: number, driftMPerMin = 0): Observation[] {
  const n = rng(3);
  const obs: Observation[] = [];
  let seq = 0, x = 0, y = 0, steps = 0, t = 0, lastStep = -1;
  for (let i = 0; t < seconds; i++, t = i * 0.02) {
    const heading = t < seconds / 2 ? 0 : Math.PI / 2;
    const ms = T0 + Math.round(t * 1000);
    obs.push({ kind: 'motion', t: ms, seq: seq++, yaw: -(heading - 1.0), ax: 0, ay: 0, az: 0.2 * Math.sin(2 * Math.PI * 2 * t), gx: 0, gy: 0, gz: -1, terrainContext: ctx });
    if (Math.floor(t * 2) !== lastStep) {
      lastStep = Math.floor(t * 2);
      x += 0.75 * Math.sin(heading);
      y += 0.75 * Math.cos(heading);
      steps++;
    }
    if (i % 125 === 0) obs.push({ kind: 'pedometer', t: ms, seq: seq++, steps, distance: steps * 0.75, terrainContext: ctx });
    if (i % 50 === 25) obs.push({ kind: 'altimeter', t: ms, seq: seq++, relativeAltitude: 0.05 * y + (driftMPerMin * t) / 60, terrainContext: ctx });
    if (i % 100 === 60) {
      const p = localToWgs84(ORIGIN, { x: x + 6 * n(), y: y + 6 * n(), z: 0 });
      obs.push({ kind: 'gps', t: ms, seq: seq++, latitude: p.latitude, longitude: p.longitude, altitude: 70, ellipsoidalAltitude: 150, horizontalAccuracy: 8, verticalAccuracy: 30, speed: -1, course: -1, terrainContext: ctx });
    }
  }
  return obs.sort(compareObservations);
}

test('v4 + terrain: the zero comes from ground contacts and outdoors the height above ground is the phone height', () => {
  const ctx = slopeTerrain();
  const s = createFusionStateV4();
  for (const o of walk(ctx, 160)) processObservationV4(s, o, cfg);
  const fin = finalizeFusionV4(s, cfg);
  assert.equal(s.smoothed!.datumSource, 'TERRAIN');
  assert.ok(s.smoothed!.contacts >= cfg.contactMinCount, `contacts ${s.smoothed!.contacts}`);
  const walking = fin.outputs.filter((o) => o.heightAboveGround !== null && o.timestamp > T0 + 30_000);
  const hag = walking.map((o) => o.heightAboveGround!).sort((a, b) => a - b);
  const med = hag[hag.length >> 1];
  assert.ok(Math.abs(med - cfg.phoneHeightM) < 0.5, `median height above ground ${med.toFixed(2)} m`);
  // ellipsoidal = orthometric + N
  const o = walking[walking.length >> 1];
  assert.ok(Math.abs(o.ellipsoidalAltitude! - (o.terrainHeight! + o.heightAboveGround! + 23.38)) < 1e-6);
  assert.equal(o.zDatumSource, 'TERRAIN');
});

test('v4 + terrain: GPS heights far from the ground are not used as the zero', () => {
  const ctx = slopeTerrain();
  const s = createFusionStateV4();
  // standing still: no ground contacts; the GPS ellipsoidal height 150 m is ~27 m above ground + phone (H = 126.6)
  for (const o of walk(ctx, 1).filter((x) => x.kind === 'gps' || x.kind === 'altimeter')) processObservationV4(s, o, cfg);
  assert.equal(s.gpsOffsets.length, 0);
});

test('terrain.buildingAt: inside a footprint and distance to the nearest edge', () => {
  const ctx = slopeTerrain();
  ctx.buildings.push({ buildingId: 'b1', name: 'test', polygons: [[[[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]]], groundFloors: 3, undergroundFloors: 0, heightM: 10, floorLabels: [] });
  assert.equal(terrain.buildingAt(ctx, 5, 5).building?.buildingId, 'b1');
  const out = terrain.buildingAt(ctx, 13, 5);
  assert.equal(out.building, null);
  assert.ok(Math.abs(out.distance - 3) < 1e-9);
});
