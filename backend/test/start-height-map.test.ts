import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadStartHeightMap, selectStartHeight, type StartHeightMap, type StartHeightRoad } from '../src/geo/start-height-map.js';
import { fusionConfigV4 as cfg } from '../src/modules/fusion/fusion.config.js';
import { createFusionStateV4 } from '../src/modules/fusion/fusion-state-v4.js';
import { finalizeFusionV4, processObservationV4 } from '../src/modules/fusion/fusion-v4.engine.js';
import { tmForward } from '../src/geo/tm.js';
import type { TerrainContext } from '../src/geo/terrain.js';
import type { Observation } from '../src/modules/fusion/fusion.timeline.js';

const road = (id: string, z: number, levelId = 'L1', status = 'APPROVED'): StartHeightRoad => ({
  id, levelId, status, buildingId: 'b', revision: 1, coordinates: [[-10, 0, z], [10, 0, z + 2]],
});
const map: StartHeightMap = { mapVersionId: 'm', roads: [road('r1', 100)], floors: [
  { id: 'b:1', buildingId: 'b', levelId: '1', phoneHeightM: 108, polygons: [[[[-20, -20], [20, -20], [20, 20], [-20, 20], [-20, -20]]]] },
  { id: 'b:2', buildingId: 'b', levelId: '2', phoneHeightM: 112, polygons: [[[[-20, -20], [20, -20], [20, 20], [-20, 20], [-20, -20]]]] },
] };

test('start materials are independently optional; road Z is interpolated and phone height added once', () => {
  assert.equal(selectStartHeight(map, 0, 0, 5, cfg, null).reason, 'NO_CANDIDATE');
  const selected = selectStartHeight(map, 0, 0, 5, { ...cfg, startHeightRoadsEnabled: true }, null).selected!;
  assert.equal(selected.kind, 'ROAD');
  assert.equal(selected.phoneHeightM, 102);
  const floor = selectStartHeight(map, 0, 0, 5, { ...cfg, startHeightFloorsEnabled: true, startHeightLevelId: '1' }, null).selected!;
  assert.equal(floor.phoneHeightM, 108); // calibrated level is already a phone height
});

test('disabled start materials need no database snapshot', async () => {
  assert.equal(await loadStartHeightMap(cfg, null), null);
});

test('stacked floors require an explicit level or GPS evidence that separates them', () => {
  const c = { ...cfg, startHeightFloorsEnabled: true };
  assert.equal(selectStartHeight(map, 0, 0, 5, c, null).reason, 'AMBIGUOUS');
  assert.equal(selectStartHeight(map, 0, 0, 5, c, { heightM: 108, accuracy: 4 }).reason, 'AMBIGUOUS');
  assert.equal(selectStartHeight(map, 0, 0, 5, c, { heightM: 108, accuracy: 1 }).selected?.levelId, '1');
  assert.equal(selectStartHeight(map, 0, 0, 5, { ...c, startHeightLevelId: '2' }, null).selected?.levelId, '2');
  assert.equal(selectStartHeight(map, 0, 0, 5, { ...c, startHeightBuildingId: 'other' }, null).reason, 'NO_CANDIDATE');
});

test('draft/retired roads, distant features and uncertain positions cannot silently supply a datum', () => {
  const m = { ...map, roads: [road('draft', 100, 'L1', 'DRAFT'), road('retired', 120, 'L1', 'RETIRED')] };
  const c = { ...cfg, startHeightRoadsEnabled: true };
  assert.equal(selectStartHeight(m, 0, 0, 5, c, null).reason, 'NO_CANDIDATE');
  assert.equal(selectStartHeight(m, 0, 0, 5, { ...c, startHeightIncludeDrafts: true }, null).selected?.id, 'draft');
  assert.equal(selectStartHeight(map, 100, 100, 5, { ...c, startHeightFloorsEnabled: true }, null).reason, 'NO_CANDIDATE');
  assert.equal(selectStartHeight(map, 0, 0, 100, c, null).reason, 'POSITION_UNCERTAIN');
});

test('v4 map start preserves subsequent barometric motion live and in replay; disabled/ambiguous choices keep DEM fallback', () => {
  const ll = { latitude: 37.6158, longitude: 127.0118 };
  const xy = tmForward(ll.latitude, ll.longitude);
  const terrain: TerrainContext = {
    versionId: 't', grid: { originX: xy.x - 100, originY: xy.y - 100, resolution: 2, width: 100, height: 100 },
    heights: new Float32Array(10000).fill(100), sigma: new Float32Array(10000).fill(1), modified: new Uint8Array(10000), geoidSeparation: 23, buildings: [],
  };
  const roads = [road('upper', 110), road('lower', 100, 'L0')].map((r) => ({ ...r, coordinates: r.coordinates.map(([x, y, z]): [number, number, number] => [x + xy.x, y + xy.y, z]) }));
  for (const mode of ['enabled', 'disabled', 'ambiguous'] as const) {
    const c = { ...cfg, startHeightRoadsEnabled: mode !== 'disabled', startHeightLevelId: mode === 'enabled' ? 'L1' : '' };
    const state = createFusionStateV4({ strideCalibration: null, startHeightMap: { mapVersionId: 'm', roads, floors: [] } });
    const outputs = [];
    for (let i = 0; i < 6; i++) {
      const obs: Observation[] = [
        { kind: 'altimeter', t: 100000 + i * 1000, seq: i, relativeAltitude: i, terrainContext: terrain },
        { kind: 'gps', t: 100000 + i * 1000, seq: i, ...ll, altitude: null, ellipsoidalAltitude: 40, horizontalAccuracy: 8, verticalAccuracy: 30, speed: -1, course: -1, terrainContext: terrain },
      ];
      for (const o of obs) outputs.push(...processObservationV4(state, o, c).outputs);
    }
    const source = mode === 'enabled' ? 'MAP_START' : 'TERRAIN_FALLBACK';
    assert.equal(outputs[0].zDatumSource, source);
    assert.ok(Math.abs(outputs.at(-1)!.ellipsoidalAltitude! - outputs[0].ellipsoidalAltitude! - 5) < 1e-6);
    if (mode === 'enabled') assert.ok(Math.abs(outputs[0].ellipsoidalAltitude! - 135) < 1e-6);
    const final = finalizeFusionV4(state, c).outputs;
    assert.ok(final.length > 0);
    assert.ok(final.every((p) => p.zDatumSource === source));
    assert.ok(Math.abs(final.at(-1)!.ellipsoidalAltitude! - final[0].ellipsoidalAltitude! - 5) < 1e-6);
    if (mode === 'ambiguous') assert.equal(state.startHeightSelection?.reason, 'AMBIGUOUS');
  }
});

test('map start yields to a trusted GPS datum instead of overriding the stronger evidence', () => {
  const ll = { latitude: 37.6158, longitude: 127.0118 };
  const xy = tmForward(ll.latitude, ll.longitude);
  const terrain: TerrainContext = {
    versionId: 't', grid: { originX: xy.x - 100, originY: xy.y - 100, resolution: 2, width: 100, height: 100 },
    heights: new Float32Array(10000).fill(100), sigma: new Float32Array(10000).fill(1), modified: new Uint8Array(10000), geoidSeparation: 23, buildings: [],
  };
  const r = road('upper', 110);
  r.coordinates = r.coordinates.map(([x, y, z]) => [xy.x + x, xy.y + y, z]);
  const s = createFusionStateV4({ strideCalibration: null, startHeightMap: { mapVersionId: 'm', roads: [r], floors: [] } });
  const c = { ...cfg, startHeightRoadsEnabled: true };
  processObservationV4(s, { kind: 'altimeter', t: 100000, seq: 0, relativeAltitude: 0, terrainContext: terrain }, c);
  for (let i = 0; i < 3; i++) {
    const out = processObservationV4(s, { kind: 'gps', t: 100000 + i * 1000, seq: i, ...ll, altitude: null,
      ellipsoidalAltitude: 124, horizontalAccuracy: 8, verticalAccuracy: 8, speed: -1, course: -1, terrainContext: terrain }, c).outputs[0];
    assert.equal(out.zDatumSource, i < 2 ? 'MAP_START' : 'GPS');
    if (i === 2) assert.equal(out.ellipsoidalAltitude, 124);
  }
});
