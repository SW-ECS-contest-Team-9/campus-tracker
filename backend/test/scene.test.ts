// Campus 3D scene import building blocks: GeoPackage geometry decoding and block heights.  npm test -w backend
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { decodeGpkgGeometry, readGpkgLayer } from '../src/geo/gpkg.js';
import { blockHeights, outlineSamples } from '../src/modules/scene/scene-heights.js';
import { gpkgSyncRows, overrideHeights, parseRoofOverrides, parseSceneOverrides, partBuildingId, partsAreaProblem, polygonArea, ringArea, sceneVersionId } from '../src/modules/scene/scene-overrides.js';

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
  assert.equal('floors' in parseRoofOverrides({ buildings: [entry] })[0], false); // no stated floor count: nothing is made up
  assert.equal(parseRoofOverrides({ buildings: [{ ...entry, floors: 15 }] })[0].floors, 15);
  assert.throws(() => parseRoofOverrides({ buildings: [{ ...entry, floors: 3.5 }] }), /floors/);
  // "terrace" on a whole building: a roof deck level with the upper ground of a slope is checked against the median ground only
  assert.equal('terrace' in parseRoofOverrides({ buildings: [entry] })[0], false);
  assert.equal(parseRoofOverrides({ buildings: [{ ...entry, terrace: 'deck' }] })[0].terrace, 'deck');
  assert.throws(() => parseRoofOverrides({ buildings: [{ ...entry, terrace: ' ' }] }), /terrace/);
  assert.deepEqual(overrides.filter((o) => o.terrace !== undefined).map((o) => [o.name, o.roofM]), [['수인관', 132.1]]); // the stored file: only the roof deck of 수인관
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
  assert.equal(parseSceneOverrides({ buildings: [], parts: [{ ...split, floors: 7 }] }).parts[0].floors, 7);
  assert.throws(() => parseSceneOverrides({ buildings: [], parts: [{ ...split, floors: 0 }] }), /floors/);
  assert.match(partsAreaProblem(ok.parts[0], 230)!, /cover 200.0 m2/);
  assert.deepEqual(parseSceneOverrides({ buildings: [] }), { roofs: [], hidden: [], parts: [], added: [] });
  assert.throws(() => parseSceneOverrides({ buildings: [], hidden: [{ name: 'H', evidence }] }), /reason/);
  assert.throws(() => parseSceneOverrides({ buildings: [], hidden: [{ name: 'A', reason: 'r', evidence }], parts: [split] }), /twice/);
  assert.throws(() => parseSceneOverrides({ buildings: [], parts: [{ ...split, parts: [split.parts[0]] }] }), /two parts/);
  assert.throws(() => parseSceneOverrides({ buildings: [], parts: [{ ...split, parts: [split.parts[0], { ...split.parts[1], id: 'a' }] }] }), /id must be unique/);
  assert.throws(() => parseSceneOverrides({ buildings: [], parts: [{ ...split, parts: [split.parts[0], { ...split.parts[1], id: 'x#y' }] }] }), /id must be unique/);
  assert.throws(() => parseSceneOverrides({ buildings: [], parts: [{ ...split, parts: [split.parts[0], { ...split.parts[1], polygon: [sq(10).slice(0, 4)] }] }] }), /closed/);
  assert.throws(() => parseSceneOverrides({ buildings: [], parts: [{ ...split, evidence: { source: 's' } }] }), /evidence/);
  assert.throws(() => parseSceneOverrides({ buildings: [], parts: [{ ...split, heightSource: 'ESTIMATE' }] }), /heightSource/);

  // "uncovered": the parts may cover less than the footprint, never more; "terrace": a roof below the highest ground of its outline
  assert.match(partsAreaProblem(ok.parts[0], 230)!, /cover 200.0 m2/); // without "uncovered" a gap is still refused
  const partial = parseSceneOverrides({ buildings: [], parts: [{ ...split, uncovered: 'open ground', parts: [split.parts[0], { ...split.parts[1], terrace: 'deck level with the upper ground' }] }] }).parts[0];
  assert.equal(partial.uncovered, 'open ground');
  assert.deepEqual(partial.parts.map((p) => p.terrace), [undefined, 'deck level with the upper ground']);
  assert.equal(partsAreaProblem(partial, 230), null);
  assert.equal(partsAreaProblem(partial, 200), null);
  assert.match(partsAreaProblem(partial, 190)!, /more than the footprint/);
  assert.throws(() => parseSceneOverrides({ buildings: [], parts: [{ ...split, uncovered: ' ' }] }), /uncovered/);
  assert.throws(() => parseSceneOverrides({ buildings: [], parts: [{ ...split, parts: [split.parts[0], { ...split.parts[1], terrace: true }] }] }), /terrace/);
  const slope = [108, 120, 122, 124, 131.7];
  const sh = blockHeights(slope, 0);
  assert.throws(() => overrideHeights(slope, sh, 129.3), /not above the ground 131.7/); // an ordinary part is refused as before
  assert.deepEqual(overrideHeights(slope, sh, 129.3, true), { heightM: 7.3, roofM: 129.3 }); // 129.3 - median 122
  assert.throws(() => overrideHeights(slope, sh, 121.9, true), /terrace roof 121.9 is not above the median ground 122/);
  assert.equal(sh.baseM, 107); // the base is still 1 m below the lowest ground
  // the stored file: only 유담관 uses the relaxed gates; its tower keeps the building id and the ordinary gate
  assert.deepEqual(all.parts.filter((o) => o.uncovered !== undefined || o.parts.some((p) => p.terrace !== undefined)).map((o) => o.name), ['유담관']);
  const yudam = all.parts.find((o) => o.name === '유담관')!;
  assert.ok(yudam.uncovered && yudam.parts[0].terrace === undefined && yudam.parts.filter((p) => p.terrace !== undefined).length === 1);
});

test('scene overrides: added buildings (not in the GeoPackage) carry their own outline, id and roof; bad entries are refused', () => {
  const dir = path.resolve(import.meta.dirname, '../data/scene');
  const all = parseSceneOverrides(JSON.parse(fs.readFileSync(path.join(dir, 'overrides/building-roofs.json'), 'utf8')));
  const names = readGpkgLayer(path.join(dir, 'source/campus.gpkg'), 'buildings_3d').features.map((f) => f.properties.name);
  // the stored file: two buildings; a GeoPackage name is reused only where that GeoPackage building is hidden
  assert.deepEqual(all.added.map((a) => [a.id, a.name, a.roofM, a.floors, a.registerId]), [['추가-공연실습소', '공연실습소', 107, 5, '53636'], ['추가-외국인생활관', '외국인 생활관', 107, undefined, undefined]]);
  assert.ok(all.added.every((a) => !names.includes(a.id) && a.evidence.independentSurvey === false && (!names.includes(a.name) || all.hidden.some((h) => h.name === a.name))));
  assert.deepEqual(all.added.map((a) => Math.round(polygonArea(a.polygon))), [634, 311]);
  // same rules as any block: base 1 m below the lowest ground of the outline, height = stated roof - median ground
  const ground = [85.31, 86, 88.049, 90, 94.033];
  const h = blockHeights(ground, 0);
  assert.equal(h.baseM, 84.31);
  assert.deepEqual(overrideHeights(ground, h, 107), { heightM: 18.951, roofM: 107 });
  assert.throws(() => overrideHeights(ground, h, 94), /not above the ground/);

  const evidence = { source: 's', collectedOn: '2026-10-10', level: 'l', independentSurvey: false };
  const sq: [number, number][] = [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]];
  const add = { id: 'new-A', name: 'A', roofM: 20, heightSource: 'SMAP_MESH', polygon: [sq], evidence };
  const hidden = { name: 'A', reason: 'r', evidence };
  const roof = { name: 'A', roofM: 10, heightSource: 'SMAP_MESH', evidence };
  assert.deepEqual(parseSceneOverrides({ buildings: [], hidden: [hidden], added: [add] }).added, [add]); // the name of a hidden building may be reused
  assert.deepEqual(parseSceneOverrides({ buildings: [], added: [{ ...add, floors: 5, registerId: '1' }] }).added[0], { ...add, floors: 5, registerId: '1' });
  assert.throws(() => parseSceneOverrides({ buildings: [roof], added: [add] }), /twice/); // not the name of a building that is still drawn
  assert.throws(() => parseSceneOverrides({ buildings: [], added: [add, { ...add, id: 'new-B' }] }), /twice/);
  assert.throws(() => parseSceneOverrides({ buildings: [], added: [add, { ...add, name: 'B' }] }), /id must be unique/);
  assert.throws(() => parseSceneOverrides({ buildings: [], added: [{ ...add, id: 'a#b' }] }), /id must be unique/);
  assert.throws(() => parseSceneOverrides({ buildings: [], added: [{ ...add, name: ' ' }] }), /name is required/);
  assert.throws(() => parseSceneOverrides({ buildings: [], added: [{ ...add, roofM: '20' }] }), /roofM/);
  assert.throws(() => parseSceneOverrides({ buildings: [], added: [{ ...add, heightSource: 'REGISTER' }] }), /heightSource/);
  assert.throws(() => parseSceneOverrides({ buildings: [], added: [{ ...add, floors: 4.5 }] }), /floors/);
  assert.throws(() => parseSceneOverrides({ buildings: [], added: [{ ...add, registerId: 53636 }] }), /registerId/);
  assert.throws(() => parseSceneOverrides({ buildings: [], added: [{ ...add, polygon: [sq.slice(0, 4)] }] }), /closed/);
  assert.throws(() => parseSceneOverrides({ buildings: [], added: [{ ...add, evidence: { source: 's' } }] }), /evidence/);
  assert.throws(() => parseSceneOverrides({ buildings: [], added: {} }), /"added" must be an array/);
  // without overrides the version id is the old one; anything applied (an added building too) gives another id
  assert.notEqual(sceneVersionId('g', 't', 'm', 'RECOMPUTED', 'x'), sceneVersionId('g', 't', 'm', 'RECOMPUTED'));
});

test('qgis:sync rows: added buildings and every row of a hidden or split building are left out, also the part that keeps the name', () => {
  const scene = [
    { building_id: '본관', name: '본관' }, { building_id: '대일관', name: '대일관' }, { building_id: '대일관#동쪽부속부', name: null },
    { building_id: '은주관', name: '은주1관' }, { building_id: '추가-공연실습소', name: '공연실습소' }, { building_id: '수인관', name: '수인관' },
  ];
  const metadata = { hiddenBuildings: [{ name: '공연실습소' }], buildingParts: [{ name: '대일관' }, { name: '은주관' }], addedBuildings: [{ id: '추가-공연실습소' }] };
  const { rows, kept } = gpkgSyncRows(scene, metadata);
  assert.deepEqual(rows.map((b) => b.building_id), ['본관', '대일관#동쪽부속부', '은주관', '수인관']); // nameless parts and 은주1관 match no GeoPackage name later
  assert.deepEqual([...kept].sort(), ['공연실습소', '대일관', '은주관']);
  assert.deepEqual(gpkgSyncRows(scene, null).rows, scene); // a scene imported without overrides syncs every row
});
