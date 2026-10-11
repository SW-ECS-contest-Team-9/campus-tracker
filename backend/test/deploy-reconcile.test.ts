import assert from 'node:assert/strict';
import { test } from 'node:test';
import { lockDrift } from '../src/deploy/dependencies.js';
import { overall, reconcile, summarize, type ReconcileDeps } from '../src/deploy/reconcile.js';
import { renameState } from '../src/modules/spatial/building-ids-rename.js';

const want = { terrainId: 'recipe-new', sceneId: 'campus3d-new' };

/** A fake database: what is active, what the files here would build, and every write that was made. */
function fake(o: { terrain?: string; scene?: string; builds?: string; imports?: string; pendingMigrations?: string[]; ids?: 'done' | 'fresh' | 'half'; failBuild?: boolean; fileProblems?: string[] } = {}) {
  const state = { terrain: o.terrain ?? 'recipe-old', scene: o.scene ?? 'campus3d-old', migrations: o.pendingMigrations ?? [], ids: o.ids ?? 'done' };
  const writes: string[] = [];
  const calls: string[] = [];
  const deps: ReconcileDeps = {
    migrations: async (apply) => {
      calls.push('migrations');
      const pending = state.migrations;
      if (apply && pending.length) { writes.push('migrate'); state.migrations = []; }
      return pending;
    },
    buildingIdState: async () => state.ids,
    renameBuildingIds: async () => { writes.push('rename'); state.ids = 'done'; },
    activeTerrain: async () => state.terrain,
    buildTerrain: async () => {
      calls.push('buildTerrain');
      if (o.failBuild) throw new Error('Base terrain does not exist');
      const id = o.builds ?? 'recipe-new';
      return { id, activate: async () => { writes.push(`terrain ${id}`); state.terrain = id; } };
    },
    activeScene: async () => state.scene,
    planScene: async () => {
      calls.push('planScene');
      const id = o.imports ?? (state.terrain === 'recipe-new' ? 'campus3d-new' : 'campus3d-on-old-terrain');
      return { id, save: async () => { writes.push(`scene ${id}`); state.scene = id; } };
    },
    preflight: async () => { calls.push('preflight'); return o.fileProblems ?? []; },
  };
  return { deps, writes, calls, state };
}

test('nothing to do: active ids equal the manifest, nothing is built or written', async () => {
  const f = fake({ terrain: 'recipe-new', scene: 'campus3d-new' });
  const r = await reconcile(want, 'on', f.deps);
  assert.deepEqual(r.map((s) => s.outcome), ['unchanged', 'unchanged', 'unchanged', 'unchanged', 'unchanged']);
  assert.deepEqual(f.writes, []);
  assert.deepEqual(f.calls, ['migrations']); // the files are not even compared
  assert.equal(overall(r, 'on'), 'in-sync');
  assert.match(summarize(r, 'on'), /^할 일 없음/);
});

test('on: applies migrations, building ids, terrain, scene in that order; a second run does nothing', async () => {
  const f = fake({ pendingMigrations: ['027_x.sql'], ids: 'fresh' });
  const r = await reconcile(want, 'on', f.deps);
  assert.deepEqual(r.map((s) => s.outcome), ['applied', 'unchanged', 'applied', 'applied', 'applied']);
  assert.deepEqual(f.writes, ['migrate', 'rename', 'terrain recipe-new', 'scene campus3d-new']);
  assert.match(summarize(r, 'on'), /^적용함: DB 이행 027_x\.sql, 건물 id 정정.*지형 recipe-old -> recipe-new, 건물 장면 campus3d-old -> campus3d-new$/);
  const again = await reconcile(want, 'on', f.deps);
  assert.equal(overall(again, 'on'), 'in-sync');
  assert.equal(f.writes.length, 4);
});

test('refuse: the recipe gives another id here -> nothing written, the scene is not attempted', async () => {
  const f = fake({ builds: 'recipe-crlf' });
  const r = await reconcile(want, 'on', f.deps);
  assert.deepEqual(r.map((s) => s.outcome), ['unchanged', 'unchanged', 'unchanged', 'refused', 'skipped']);
  assert.deepEqual(f.writes, []);
  assert.equal(f.state.terrain, 'recipe-old');
  assert.ok(!f.calls.includes('planScene'));
  assert.match(summarize(r, 'on'), /^거부\(DB는 그대로 둠\): 지형 .*recipe-crlf.*recipe-new/);
});

test('refuse: the scene import gives another id -> the terrain stays applied, the scene is not saved', async () => {
  const f = fake({ imports: 'campus3d-crlf' });
  const r = await reconcile(want, 'on', f.deps);
  assert.deepEqual(r.map((s) => s.outcome), ['unchanged', 'unchanged', 'unchanged', 'applied', 'refused']);
  assert.deepEqual(f.writes, ['terrain recipe-new']);
  assert.equal(f.state.scene, 'campus3d-old');
  assert.equal(overall(r, 'on'), 'refused');
  assert.match(summarize(r, 'on'), /그 전에 적용한 것: 지형/);
});

test('refuse before any write: a data file of this checkout differs from the manifest (corrupted recipe, CRLF overrides, other campus map)', async () => {
  for (const mode of ['on', 'dry-run'] as const) {
    const f = fake({ ids: 'fresh', fileProblems: ['data/scene/overrides/building-roofs.json has CRLF line endings'] });
    const r = await reconcile(want, mode, f.deps);
    assert.deepEqual(r.map((s) => s.outcome), ['unchanged', 'refused', 'skipped', 'skipped', 'skipped']);
    assert.deepEqual(f.writes, []);
    assert.ok(!f.calls.includes('buildTerrain'));
    assert.match(summarize(r, mode), /^거부\(DB는 그대로 둠\): 자료 파일 .*CRLF/);
  }
});

test('half-renamed building ids are refused and stop the later steps', async () => {
  const f = fake({ ids: 'half' });
  const r = await reconcile(want, 'on', f.deps);
  assert.deepEqual(r.map((s) => s.outcome), ['unchanged', 'unchanged', 'refused', 'skipped', 'skipped']);
  assert.deepEqual(f.writes, []);
});

test('dry-run: reports what is pending (terrain id verified by building it) and writes nothing', async () => {
  const f = fake({ pendingMigrations: ['027_x.sql'], ids: 'fresh' });
  const r = await reconcile(want, 'dry-run', f.deps);
  assert.deepEqual(r.map((s) => s.outcome), ['pending', 'unchanged', 'pending', 'pending', 'pending']);
  assert.deepEqual(f.writes, []);
  assert.ok(f.calls.includes('buildTerrain') && !f.calls.includes('planScene')); // the scene id cannot be checked before the terrain is active
  assert.match(summarize(r, 'dry-run'), /^받은 저장소 상태와 DB가 다름: .*지형 recipe-old -> recipe-new.*`npm run deploy:sync` 로 적용$/);
});

test('dry-run: only the scene differs -> its id is verified; a wrong id is reported as refused', async () => {
  const ok = fake({ terrain: 'recipe-new' });
  assert.deepEqual((await reconcile(want, 'dry-run', ok.deps)).map((s) => s.outcome), ['unchanged', 'unchanged', 'unchanged', 'unchanged', 'pending']);
  const bad = fake({ terrain: 'recipe-new', imports: 'campus3d-crlf' });
  assert.equal(overall(await reconcile(want, 'dry-run', bad.deps), 'dry-run'), 'refused');
  assert.deepEqual([...ok.writes, ...bad.writes], []);
});

test('off: nothing is read or written', async () => {
  const f = fake();
  const r = await reconcile(want, 'off', f.deps);
  assert.deepEqual(r, []);
  assert.deepEqual([...f.calls, ...f.writes], []);
  assert.equal(overall(r, 'off'), 'off');
});

test('a step that throws is reported as failed and the later steps are skipped (the caller never sees an exception)', async () => {
  const f = fake({ failBuild: true });
  const r = await reconcile(want, 'on', f.deps);
  assert.deepEqual(r.map((s) => s.outcome), ['unchanged', 'unchanged', 'unchanged', 'failed', 'skipped']);
  assert.match(summarize(r, 'on'), /^실패.*Base terrain does not exist/);
});

test('building id rename state', () => {
  const fixes = [{ feature: 'building-1', from: '혜인관', id: '혜인관-중복도형', name: '혜인관', reason: 'r' }, { feature: 'building-5', from: '건물5', id: '혜인관', name: '혜인관', reason: 'r' }];
  assert.equal(renameState(new Set(['혜인관', '건물5', '본관']), fixes), 'fresh');
  assert.equal(renameState(new Set(['혜인관-중복도형', '혜인관', '본관']), fixes), 'done');
  assert.equal(renameState(new Set(['혜인관-중복도형', '건물5', '본관']), fixes), 'half');
});

test('dependency drift: version changes and missing packages are listed, optional and workspace links are not', () => {
  const wanted = { '': {}, backend: {}, 'node_modules/backend': { link: true }, 'node_modules/pg': { version: '8.23.1' }, 'node_modules/zod': { version: '4.6.5' },
    'node_modules/@esbuild/linux-x64': { version: '1.0.0', optional: true }, 'node_modules/a/node_modules/b': { version: '2.0.0' } };
  assert.deepEqual(lockDrift(wanted, { 'node_modules/pg': { version: '8.23.1' }, 'node_modules/zod': { version: '4.6.5' }, 'node_modules/a/node_modules/b': { version: '2.0.0' } }), []);
  assert.deepEqual(lockDrift(wanted, { 'node_modules/pg': { version: '8.20.0' }, 'node_modules/a/node_modules/b': { version: '2.0.0' } }), ['pg@8.23.1', 'zod@4.6.5']);
});
