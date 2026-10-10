// Campus 3D scene import building blocks: GeoPackage geometry decoding and block heights.  npm test -w backend
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { decodeGpkgGeometry, readGpkgLayer } from '../src/geo/gpkg.js';
import { blockHeights, outlineSamples } from '../src/modules/scene/scene-heights.js';
import { overrideHeights, parseRoofOverrides, parseSceneOverrides, partBuildingId, partsAreaProblem, polygonArea, ringArea, sceneVersionId } from '../src/modules/scene/scene-overrides.js';

/** GeoPackage blob: "GP", version 0, flags (little endian, no envelope), srs 5186, then WKB polygon. */
function gpkgPolygon(ring: [number, number][]): Uint8Array {
  const wkb = Buffer.alloc(1 + 4 + 4 + 4 + ring.length * 16);
  let o = 0;
  wkb.writeUInt8(1, o); o += 1;
  wkb.writeUInt32LE(3, o); o += 4;
  wkb.writeUInt32LE(1, o); o += 4;
  wkb.writeUInt32LE(ring.length, o); o += 4;
  for (const [x, y] of ring) { wkb.writeDoubleLE(x, o); wkb.writeDoubleLE(y, o + 8); o += 16; }
  const header = Buffer.from([0x47, 0x50, 0, 0b00000001, 0, 0, 0, 0]);
  header.writeInt32LE(5186, 4);
  return new Uint8Array(Buffer.concat([header, wkb]));
}

test('GeoPackage geometry: header + WKB polygon', () => {
  const g = decodeGpkgGeometry(gpkgPolygon([[0, 0], [10, 0], [10, 5], [0, 0]]));
  assert.deepEqual(g, { type: 'Polygon', coordinates: [[[0, 0], [10, 0], [10, 5], [0, 0]]] });
});

test('GeoPackage reader: the stored campus model has 12 buildings in EPSG:5186', { skip: !fs.existsSync(path.resolve(import.meta.dirname, '../data/scene/source/campus.gpkg')) }, () => {
  const l = readGpkgLayer(path.resolve(import.meta.dirname, '../data/scene/source/campus.gpkg'), 'buildings_3d');
  assert.equal(l.srsId, 5186);
  assert.equal(l.features.length, 12);
  assert.ok(l.features.every((f) => f.geometry?.type === 'MultiPolygon' && typeof f.properties.height_m === 'number'));
});

test('block heights: base below the lowest ground, roof = median + height, never buried on a slope', () => {
  const flat = blockHeights([100, 100.5, 101], 20);
  assert.equal(flat.baseM, 99);
  assert.equal(flat.roofM, 120.5);
  assert.equal(flat.roofRaised, false);
  const steep = blockHeights([100, 101, 130], 5); // median 101 + 5 < max 130 + 3
  assert.equal(steep.roofM, 133);
  assert.equal(steep.roofRaised, true);
  assert.equal(outlineSamples([[[[0, 0], [10, 0], [10, 10], [0, 0]]]], 2).length, 5 + 5 + 8);
});

test('roof overrides: stored file carries provenance and names buildings of the model; heights stay consistent', () => {
  const dir = path.resolve(import.meta.dirname, '../data/scene');
  const overrides = parseRoofOverrides(JSON.parse(fs.readFileSync(path.join(dir, 'overrides/building-roofs.json'), 'utf8')));
  const names = readGpkgLayer(path.join(dir, 'source/campus.gpkg'), 'buildings_3d').features.map((f) => f.properties.name);
  assert.ok(overrides.length > 0 && overrides.every((o) => names.includes(o.name) && o.heightSource.length <= 16));
  assert.ok(overrides.every((o) => o.evidence.independentSurvey === false)); // nothing here is a field survey yet

  const samples = [131, 139, 139.5, 140.8];
  const h = blockHeights(samples, 14);
  assert.deepEqual(overrideHeights(samples, h, 189.4), { heightM: 50.15, roofM: 189.4 }); // 189.4 - median 139.25
  assert.throws(() => overrideHeights(samples, h, 140.8), /not above the ground/);

  const entry = { name: 'A', roofM: 10, heightSource: 'SMAP_MESH', evidence: { source: 's', collectedOn: '2026-10-10', level: 'l', independentSurvey: false } };
  assert.equal(parseRoofOverrides({ buildings: [entry] })[0].roofM, 10);
  assert.throws(() => parseRoofOverrides({ buildings: [entry, entry] }), /twice/);
  assert.throws(() => parseRoofOverrides({ buildings: [{ ...entry, evidence: { source: 's' } }] }), /evidence/);
  assert.throws(() => parseRoofOverrides({ buildings: [{ ...entry, heightSource: 'REGISTER' }] }), /heightSource/);
  assert.throws(() => parseRoofOverrides({ buildings: [{ ...entry, roofM: '189' }] }), /roofM/);
});

test('scene version id: unchanged without roof overrides (the live id), different with them', () => {
  const live = ['26c66faa36bd03c3f7106d68ac8a2f8e0a89a452f7899e5b0f20ab0673b45d13', 'seoul5000-2015-ba7fcb19', '28265795d5fb0966', 'RECOMPUTED'] as const;
  assert.equal(sceneVersionId(...live), 'campus3d-ae7db7a7');
  assert.notEqual(sceneVersionId(...live, 'abc'), 'campus3d-ae7db7a7');
});

test('scene overrides: hidden buildings and split footprints of the stored file match the model; bad entries are refused', () => {
  const dir = path.resolve(import.meta.dirname, '../data/scene');
  const doc = JSON.parse(fs.readFileSync(path.join(dir, 'overrides/building-roofs.json'), 'utf8'));
  const all = parseSceneOverrides(doc);
  const features = readGpkgLayer(path.join(dir, 'source/campus.gpkg'), 'buildings_3d').features;
  const names = features.map((f) => f.properties.name);
  assert.deepEqual(all.roofs, parseRoofOverrides(doc)); // roof entries read as before
  assert.ok([...all.hidden, ...all.parts].every((o) => names.includes(o.name) && o.evidence.independentSurvey === false));
  assert.equal(new Set([...all.roofs, ...all.hidden, ...all.parts].map((o) => o.name)).size, all.roofs.length + all.hidden.length + all.parts.length);
  for (const o of all.parts) {
    const g = features.find((f) => f.properties.name === o.name)!.geometry as { type: 'MultiPolygon'; coordinates: [number, number][][][] };
    const area = g.coordinates.reduce((s, poly) => s + polygonArea(poly), 0);
    assert.equal(partsAreaProblem(o, area), null); // the parts tile the GeoPackage footprint (within 1 m2)
    const xs = g.coordinates.flatMap((poly) => poly[0].map((c) => c[0]));
    const ys = g.coordinates.flatMap((poly) => poly[0].map((c) => c[1]));
    assert.ok(o.parts.every((p) => p.polygon.flat().every(([x, y]) => x >= Math.min(...xs) - 0.01 && x <= Math.max(...xs) + 0.01 && y >= Math.min(...ys) - 0.01 && y <= Math.max(...ys) + 0.01)));
    assert.equal(partBuildingId('B', o.parts, 0), 'B'); // references to the building id stay valid
    assert.equal(new Set(o.parts.map((_, k) => partBuildingId('B', o.parts, k))).size, o.parts.length);
    assert.ok(o.parts.slice(1).every((p, k) => partBuildingId('B', o.parts, k + 1) === `B#${p.id}`));
  }

  const evidence = { source: 's', collectedOn: '2026-10-10', level: 'l', independentSurvey: false };
  const sq = (x: number): [number, number][] => [[x, 0], [x + 10, 0], [x + 10, 10], [x, 10], [x, 0]];
  const split = { name: 'A', heightSource: 'SMAP_MESH', evidence, parts: [{ id: 'a', name: 'A1', roofM: 20, polygon: [sq(0)] }, { id: 'b', roofM: 30, polygon: [sq(10)] }] };
  const ok = parseSceneOverrides({ buildings: [], hidden: [{ name: 'H', reason: 'r', evidence }], parts: [split] });
  assert.equal(ok.hidden[0].name, 'H');
  assert.deepEqual(ok.parts[0].parts.map((p) => [p.id, p.name, p.roofM]), [['a', 'A1', 20], ['b', null, 30]]);
  assert.equal(ringArea(sq(0)), 100);
  assert.equal(polygonArea([sq(0), [[2, 2], [4, 2], [4, 4], [2, 4], [2, 2]]]), 96);
  assert.equal(partsAreaProblem(ok.parts[0], 200), null);
  assert.match(partsAreaProblem(ok.parts[0], 230)!, /cover 200.0 m2/);
  assert.deepEqual(parseSceneOverrides({ buildings: [] }), { roofs: [], hidden: [], parts: [] });
  assert.throws(() => parseSceneOverrides({ buildings: [], hidden: [{ name: 'H', evidence }] }), /reason/);
  assert.throws(() => parseSceneOverrides({ buildings: [], hidden: [{ name: 'A', reason: 'r', evidence }], parts: [split] }), /twice/);
  assert.throws(() => parseSceneOverrides({ buildings: [], parts: [{ ...split, parts: [split.parts[0]] }] }), /two parts/);
  assert.throws(() => parseSceneOverrides({ buildings: [], parts: [{ ...split, parts: [split.parts[0], { ...split.parts[1], id: 'a' }] }] }), /id must be unique/);
  assert.throws(() => parseSceneOverrides({ buildings: [], parts: [{ ...split, parts: [split.parts[0], { ...split.parts[1], id: 'x#y' }] }] }), /id must be unique/);
  assert.throws(() => parseSceneOverrides({ buildings: [], parts: [{ ...split, parts: [split.parts[0], { ...split.parts[1], polygon: [sq(10).slice(0, 4)] }] }] }), /closed/);
  assert.throws(() => parseSceneOverrides({ buildings: [], parts: [{ ...split, evidence: { source: 's' } }] }), /evidence/);
  assert.throws(() => parseSceneOverrides({ buildings: [], parts: [{ ...split, heightSource: 'ESTIMATE' }] }), /heightSource/);
});
