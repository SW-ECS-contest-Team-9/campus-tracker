import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { defaultBuildingId, parseBuildingIdFixes, resolveBuildingIds } from '../src/modules/spatial/building-ids.js';

const features = [
  { id: 'building-1', name: '혜인관' },   // the duplicate polygon on the 혜인관 site
  { id: 'building-2', name: '유 담관' },
  { id: 'building-5', name: null },       // the real 혜인관, unnamed in the file
];
const fixes = parseBuildingIdFixes(JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, '../data/campus-map/overrides/building-ids.json'), 'utf8')));

test('ids without corrections are the name without spaces, or 건물<n>', () => {
  assert.deepEqual(features.map(defaultBuildingId), ['혜인관', '유담관', '건물5']);
  assert.deepEqual(resolveBuildingIds(features, []).map((f) => [f.buildingId, f.buildingName]), [['혜인관', '혜인관'], ['유담관', '유 담관'], ['건물5', null]]);
});

test('the stored corrections give the real 혜인관 its id and move the duplicate away', () => {
  assert.deepEqual(resolveBuildingIds(features, fixes).map((f) => [f.id, f.buildingId, f.buildingName]),
    [['building-1', '혜인관-중복도형', '혜인관'], ['building-2', '유담관', '유 담관'], ['building-5', '혜인관', '혜인관']]);
});

test('a correction that no longer matches the file, or that makes two footprints share an id, is refused', () => {
  assert.throws(() => resolveBuildingIds([{ id: 'building-1', name: '본관' }, features[2]], fixes), /gives it "본관"/);
  assert.throws(() => resolveBuildingIds(features.slice(0, 2), fixes), /no such footprint/);
  assert.throws(() => resolveBuildingIds(features, fixes.slice(1)), /Duplicate building name\/ID: 혜인관/);
  assert.throws(() => parseBuildingIdFixes({ ids: [{ feature: 'building-5', from: '건물5', id: '혜 인관', name: null, reason: 'r' }] }), /id must be unique/);
  assert.throws(() => parseBuildingIdFixes({ ids: [{ feature: 'building-5', from: '건물5', id: '혜인관', name: null }] }), /reason is required/);
});
