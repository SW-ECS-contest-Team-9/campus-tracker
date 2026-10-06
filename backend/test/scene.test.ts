// Campus 3D scene import building blocks: GeoPackage geometry decoding and block heights.  npm test -w backend
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { decodeGpkgGeometry, readGpkgLayer } from '../src/geo/gpkg.js';
import { blockHeights, outlineSamples } from '../src/modules/scene/scene-heights.js';

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
