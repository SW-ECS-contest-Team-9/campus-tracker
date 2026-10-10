// Node reuse and joining by height, against a real PostGIS. Run only against a disposable EMPTY database:
//   EDITOR_TEST_DATABASE_URL=postgresql://.../some_scratch_db node --import tsx --test test/editor-height-join.integration.test.ts
// The test installs its own fixture (collectors, a terrain extent, the mobility/editor migrations). Never point it at a database in use.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { XYZ } from '../src/modules/editor/topology.js';

test('heights are kept: node reuse within 0.3 m only, ramps join levels, explicit joins still work',
  { skip: !process.env.EDITOR_TEST_DATABASE_URL }, async () => {
    process.env.DATABASE_URL = process.env.EDITOR_TEST_DATABASE_URL;
    process.env.JWT_SECRET ||= 'editor-height-join-test';
    const { pool } = await import('../src/config/database.js');
    const { editorService } = await import('../src/modules/editor/editor.service.js');
    const { editorOps } = await import('../src/modules/editor/editor.ops.js');
    const { RoadSave } = await import('../src/modules/editor/editor.dto.js');
    const { validateNetwork } = await import('../src/modules/editor-mcp/network-validate.js');
    try {
      await pool.query(`CREATE EXTENSION IF NOT EXISTS postgis;
        CREATE TABLE terrain_versions(active boolean,origin_x float8,origin_y float8,width int,height int,resolution_m float8);
        INSERT INTO terrain_versions VALUES(true,200000,557000,2000,2000,1);`);
      for (const migration of ['002_collectors.sql', '019_mobility_spaces.sql', '020_mobility_defaults.sql', '023_network_editor.sql', '024_elevator_roads.sql', '026_editor_display_color.sql']) {
        await pool.query(await readFile(new URL(`../src/db/migrations/${migration}`, import.meta.url), 'utf8'));
      }
      await pool.query(`INSERT INTO collectors(collector_code) VALUES('T01')`);
      const identity = { collectorId: 'T01', collectorDatabaseId: randomUUID(), deviceDatabaseId: randomUUID(), clientDeviceId: 'test' };
      const sessionId = randomUUID();
      const lease = async (id: string) => (await editorService.acquireLease({ objectType: 'road', objectId: id, sessionId }, identity)).leaseToken as string;

      type Saved = { id: string; from: string; to: string; structure: string; level: string | null; c: XYZ[] };
      const active = async (): Promise<Saved[]> => (await pool.query(`SELECT id, from_node_id "from", to_node_id "to", structure, level_id "level",
        (ST_AsGeoJSON(geom)::json->'coordinates') c FROM mobility.road_segments WHERE status IN ('DRAFT','APPROVED')`)).rows;
      const nodeZ = async (id: string) => (await pool.query<{ z: number }>(`SELECT ST_Z(geom)::float8 z FROM mobility.network_nodes WHERE id=$1`, [id])).rows[0].z;
      /** Saves one drawn line the way the editor does (preview, leases for roads it splits, save); returns its active pieces in drawing order. */
      const draw = async (coordinates: XYZ[], attrs: { structure?: string; levelId?: string | null } = {}) => {
        const id = randomUUID(), structure = attrs.structure ?? 'ordinary', levelId = attrs.levelId ?? null;
        const preview = await editorService.previewTopology(coordinates, levelId, undefined, [], pool, structure);
        const affected = [];
        for (const n of preview.needsLease) affected.push({ id: n.id, revision: n.revision, leaseToken: await lease(n.id), sessionId });
        const saved = await editorService.saveRoad(RoadSave.parse({ id, roadClass: 'pedestrian', structure, levelId, coordinates, expectedRevision: null,
          leaseToken: await lease(id), sessionId, anchors: [], affected, mutationId: randomUUID() }), identity);
        // pieces of the drawn line itself: created with no parent, or with the drawn id as parent (pieces of roads it split have that road as parent)
        const ids = new Set<string>(saved.events.filter((e: any) => e.objectType === 'road' && e.operation === 'created' && (e.payload.parentId ?? id) === id).map((e: any) => e.objectId));
        return { preview, pieces: (await active()).filter((r) => ids.has(r.id)) };
      };
      const one = async (coordinates: XYZ[], attrs: { structure?: string; levelId?: string | null } = {}) => {
        const { pieces } = await draw(coordinates, attrs);
        assert.equal(pieces.length, 1, 'saved as one piece');
        return pieces[0];
      };
      const findings = async (codes: string[]) => {
        const roads = (await active()).map((r) => ({ id: r.id, name: null, structure: r.structure, vehicleAccess: 'unknown', wheelchairAccess: 'unknown', levelId: r.level, fromNodeId: r.from, toNodeId: r.to, coordinates: r.c }));
        const { rows: nodes } = await pool.query(`SELECT id, level_id "levelId", (ST_AsGeoJSON(geom)::json->'coordinates') coordinate FROM mobility.network_nodes`);
        return validateNetwork(roads, nodes, codes as any);
      };
      const X = 201_000, Y = 557_300;
      const p = (x: number, y: number, z: number): XYZ => [X + x, Y + y, z];

      // A. Two roads end at the same plan point 1.0 m apart in height (한림관 6F deck 147.9 / field path 148.9): two nodes, and a finding.
      const deck = await one([p(0, 0, 147.9), p(10, 0, 147.9)]);
      const path = await one([p(10, 0, 148.9), p(20, 0, 148.9)]);
      assert.notEqual(path.from, deck.to);
      assert.equal(path.c[0][2], 148.9, 'the path end keeps its own height');
      assert.equal(await nodeZ(deck.to), 147.9);
      const gapA = (await findings(['DUPLICATE_NODES', 'NODES_HEIGHT_GAP'])).filter((f) => f.nodeIds!.includes(deck.to));
      assert.deepEqual(gapA.map((f) => f.code), ['NODES_HEIGHT_GAP']);
      assert.deepEqual([...gapA[0].nodeIds!].sort(), [deck.to, path.from].sort());
      // ... and merge_nodes refuses to flatten it, saying why
      await assert.rejects(editorOps.mergeNodes({ keepNodeId: deck.to, removeNodeId: path.from, sessionId, mutationId: randomUUID() }, identity),
        (e: any) => e.code === 'NODES_TOO_FAR' && /1\.00 m apart/.test(e.message) && /stairs or a ramp/.test(e.message));

      // B. 0.2 m apart: one node, the later end takes the node's height.
      const b1 = await one([p(0, 100, 140), p(10, 100, 140)]);
      const b2 = await one([p(10, 100, 140.2), p(20, 100, 140.2)]);
      assert.equal(b2.from, b1.to);
      assert.equal(b2.c[0][2], 140);

      // C. A ramp (ground, level null) reaches a basement corridor (level B1): its end reuses the B1 node within 0.3 m ...
      const corridor = await one([p(0, 200, 126.8), p(10, 200, 126.8)], { levelId: 'B1', structure: 'indoor_corridor' });
      const ramp = await one([p(-30, 200, 131), p(0, 200, 126.95)], { structure: 'ramp' });
      assert.equal(ramp.to, corridor.from, 'ramp end joined the B1 node');
      assert.equal(ramp.c.at(-1)![2], 126.8);
      // ... an ordinary ground road ending on another B1 node at the same height does not (levels are not fused by accident) ...
      const ground = await one([p(10, 200.05, 126.8), p(10, 210, 126.8)]);
      assert.notEqual(ground.from, corridor.to);
      // ... but an ordinary ground road ending where the ramp ends reuses that node (it ends a connector) ...
      const side = await one([p(0, 200, 126.8), p(0, 190, 126.8)]);
      assert.equal(side.from, ramp.to);
      // ... and a ramp end 0.6 m above a floor node stays its own node.
      const corridor2 = await one([p(0, 230, 126.8), p(10, 230, 126.8)], { levelId: 'B1', structure: 'indoor_corridor' });
      const shortRamp = await one([p(-30, 230, 131), p(0, 230, 127.4)], { structure: 'ramp' });
      assert.notEqual(shortRamp.to, corridor2.from);
      assert.equal(shortRamp.c.at(-1)![2], 127.4);
      // An outdoor ramp on one level (the uphill footpath) just joins the ground roads at its ends, like any road.
      const lower = await one([p(40, 200, 130.6), p(40, 190, 130.6)]);
      const footpath = await one([p(40, 200, 130.7), p(80, 200, 141)], { structure: 'ramp' });
      assert.equal(footpath.from, lower.from);

      // D. An elevator's two ends, 0.8 m apart at one x,y, stay two nodes.
      const lift = await one([p(0, 300, 140), p(0, 300, 140.8)], { structure: 'elevator' });
      assert.notEqual(lift.from, lift.to);
      assert.deepEqual([await nodeZ(lift.from), await nodeZ(lift.to)], [140, 140.8]);

      // E. Four risers (0.68 m), steep enough that both ends are within 0.15 m in plan: two nodes.
      const steps = await one([p(0, 400, 143), p(0.1, 400, 143.68)], { structure: 'stairs' });
      assert.notEqual(steps.from, steps.to);
      // A path drawn at the lower height up to the stair top does not get pulled up 0.68 m onto the top node.
      const under = await one([p(10, 400, 143), p(0.1, 400, 143)]);
      assert.equal(under.to, steps.from, 'it meets the stair foot (0.1 m away, same height)');
      assert.equal(under.c.at(-1)![2], 143);

      // F. Crossing roads: 1.0 m apart nothing is split or joined; 0.2 m apart both are split at one junction.
      const f1 = await one([p(0, 500, 150), p(10, 510, 150)]);
      const over = await draw([p(0, 510, 151), p(10, 500, 151)]);
      assert.equal(over.preview.crossings.length, 0);
      assert.equal(over.pieces.length, 1);
      assert.ok((await active()).some((r) => r.id === f1.id), 'the lower road is untouched');
      assert.deepEqual((await findings(['UNCONNECTED_CROSSING'])).filter((f) => f.roadIds.includes(f1.id)).map((f) => f.severity), ['warning']);
      const g1 = await one([p(0, 600, 150), p(10, 610, 150)]);
      const through = await draw([p(0, 610, 150.2), p(10, 600, 150.2)]);
      assert.equal(through.preview.crossings.length, 1);
      assert.equal(through.pieces.length, 2);
      assert.equal(through.pieces[0].to === through.pieces[1].from || through.pieces[0].from === through.pieces[1].to, true);
      assert.ok(!(await active()).some((r) => r.id === g1.id), 'the crossed road was split');
      const junction = through.pieces[0].to === through.pieces[1].from ? through.pieces[0].to : through.pieces[0].from;
      assert.equal(await nodeZ(junction), 150.1);

      // G. Explicit paths. connect_roads (junction) still joins roads up to 1.25 m apart, at their mean height.
      const j1 = await one([p(0, 700, 150), p(10, 710, 150)]);
      const j2 = await one([p(0, 710, 151), p(10, 700, 151)]);
      const cursor = p(5, 705, 150.5);
      const jp = await editorService.previewJunction(cursor);
      assert.deepEqual(jp.roads.map((r) => r.id).sort(), [j1.id, j2.id].sort());
      const roads = [];
      for (const r of jp.roads) roads.push({ id: r.id, revision: r.revision, leaseToken: await lease(r.id) });
      const joined = await editorService.saveJunction({ coordinate: cursor, roads, sessionId, mutationId: randomUUID() }, identity);
      assert.equal(joined.coordinate[2], 150.5);
      assert.equal((await active()).filter((r) => r.from === joined.nodeId || r.to === joined.nodeId).length, 4);
      // move_node: a node may sit 1.0 m under another one, but not on it.
      const m1 = await one([p(0, 800, 150), p(10, 800, 150)]);
      const m2 = await one([p(20, 800, 151), p(30, 800, 151)]);
      await editorOps.moveNode({ nodeId: m2.from, coordinate: p(10, 800, 151), sessionId, mutationId: randomUUID() }, identity);
      await assert.rejects(editorOps.moveNode({ nodeId: m2.from, coordinate: p(10, 800, 150.2), sessionId, mutationId: randomUUID() }, identity), (e: any) => e.code === 'NODE_COLLISION');
      assert.notEqual(m1.to, m2.from);
      // split_road on a ramp: the new node belongs to the ramp and both pieces meet on it.
      const long = await one([p(0, 900, 150), p(20, 900, 148)], { structure: 'ramp' });
      const { rows: [{ revision }] } = await pool.query<{ revision: number }>('SELECT revision FROM mobility.road_segments WHERE id=$1', [long.id]);
      const cut = await editorOps.splitRoad({ roadId: long.id, expectedRevision: revision, measureM: 10, sessionId, mutationId: randomUUID() }, identity);
      assert.equal(cut.coordinate[2], 149);
      assert.equal((await active()).filter((r) => cut.roadIds.includes(r.id) && (r.from === cut.nodeId || r.to === cut.nodeId)).length, 2);

      // Nothing above produced a duplicate node (two nodes that should have been one).
      assert.deepEqual(await findings(['DUPLICATE_NODES']), []);
    } finally { await pool.end(); }
  });
