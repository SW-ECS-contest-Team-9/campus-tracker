// The committed desired-state manifest must describe the committed data files. No database needed.
// When this fails: run `npm run deploy:manifest` (with a test database) and commit the manifest with the data change.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { BACKEND_DIR, inputHashes, loadManifest, manifestProblems } from '../src/deploy/manifest.js';
import { sceneVersionId } from '../src/modules/scene/scene-overrides.js';

const m = loadManifest();
const notLineEndings = (p: string) => !p.includes('CRLF'); // a Windows checkout may have CRLF; the hashes are of the LF text

test('the manifest is not stale: recipe + inputs, recipe settings, building ids, scene source and overrides match their hashes', () => {
  assert.deepEqual(manifestProblems(m).filter(notLineEndings), [], 'run `npm run deploy:manifest` and commit data/deploy/desired-state.json');
});

test('the manifest scene id is the id of its own inputs (GeoPackage, terrain id, map id, overrides)', () => {
  const h = inputHashes(m);
  assert.equal(m.scene.id, sceneVersionId(h.gpkg, m.terrain.id, m.mapVersionId, 'RECOMPUTED', h.overrides));
  assert.match(m.terrain.id, /^recipe-[0-9a-f]{16}$/);
});

test('a changed recipe input, a changed overrides file and CRLF overrides are each named', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'd01-manifest-'));
  try {
    fs.cpSync(path.join(BACKEND_DIR, 'data'), path.join(root, 'data'), { recursive: true });
    const overrides = path.join(root, m.scene.overrides);
    const lf = fs.readFileSync(overrides, 'utf8').replace(/\r\n/g, '\n');
    fs.writeFileSync(overrides, lf);
    assert.deepEqual(manifestProblems(m, root), []);
    fs.writeFileSync(overrides, lf.replace(/\n/g, '\r\n'));
    assert.match(manifestProblems(m, root).join(), /CRLF line endings/);
    fs.writeFileSync(overrides, lf.replace('"', '" '));
    assert.match(manifestProblems(m, root).join(), /building-roofs\.json differs from the manifest/);
    const surface = path.join(root, 'data/terrain/recipes/platforms-surface.geojson'); // an input file of the recipe, not the recipe itself
    fs.writeFileSync(surface, fs.readFileSync(surface, 'utf8').replace(/(\d)\.(\d)/, '$1.9$2'));
    assert.match(manifestProblems(m, root).join(), /recipe .* or one of its input files differs/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
