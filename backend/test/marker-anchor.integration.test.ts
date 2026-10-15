// Collection anchors against a disposable PostGIS DB (FUSION_TEST_DATABASE_URL, name ending in _test); rolled back.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

test('anchor markers: stored with the node snapshot, fed to fusion, listed by the node picker, labelled on the session',
  { skip: !process.env.FUSION_TEST_DATABASE_URL, timeout: 60_000 }, async () => {
    const url = new URL(process.env.FUSION_TEST_DATABASE_URL!);
    assert.match(url.pathname, /_test$/);
    process.env.DATABASE_URL = url.toString();
    const { pool } = await import('../src/config/database.js');
    const { migrate } = await import('../src/db/migrator.js');
    const { markerRepository } = await import('../src/modules/markers/marker.repository.js');
    const { MarkerCreateRequest } = await import('../src/modules/markers/marker.dto.js');
    const { sessionRepository } = await import('../src/modules/sessions/session.repository.js');
    const { trainingLabel } = await import('../src/modules/markers/marker-anchor.js');
    const { loadAnchorNodes, pickAnchorNodes } = await import('../src/modules/mobility/anchor-nodes.js');
    let client;
    try {
      await migrate();
      client = await pool.connect();
      await client.query('BEGIN');
      const collector = randomUUID(), device = randomUUID(), session = randomUUID(), owner = `AN${collector.slice(0, 6)}`;
      await client.query('INSERT INTO collectors(id,collector_code) VALUES($1,$2)', [collector, owner]);
      await client.query('INSERT INTO devices(id,collector_id,client_device_id) VALUES($1,$2,$3)', [device, collector, 'anchor-test']);
      await client.query(`INSERT INTO collection_sessions(id,client_session_id,collector_id,device_id,started_at) VALUES($1,$2,$3,$4,now())`,
        [session, randomUUID(), collector, device]);
      const [n1, n2, gone] = [randomUUID(), randomUUID(), randomUUID()];
      const node = (id: string, x: number, z: number) => client!.query(
        `INSERT INTO mobility.network_nodes(id,kind,level_id,geom) VALUES($1,'junction',NULL,ST_SetSRID(ST_MakePoint($2,$3,$4),5186))`, [id, x, 552000, z]);
      await node(n1, 200000, 140.5); await node(n2, 200010, 140.5); await node(gone, 200020, 143.5);
      await client.query(`INSERT INTO mobility.road_segments(from_node_id,to_node_id,road_class,structure,building_id,level_id,geom,created_by,updated_by)
        VALUES($1,$2,'pedestrian','indoor_corridor','북악관','3층',ST_SetSRID(ST_MakeLine(ST_MakePoint(200000,552000,140.5),ST_MakePoint(200010,552000,140.5)),5186),$3,$3)`,
        [n1, n2, owner]);

      const ts = (s: number) => new Date(Date.UTC(2026, 9, 15, 1, 0, s)).toISOString();
      const marker = (type: string, s: number, f: Record<string, unknown>) => MarkerCreateRequest.parse({ markerId: randomUUID(), sessionId: session,
        timestamp: ts(s), type, latitude: 37.61, longitude: 127.0, ...f });
      await markerRepository.insert(session, marker('sessionStart', 0, { nodeId: n1, buildingId: '북악관', floor: '3F' }), client);
      await markerRepository.insert(session, marker('stairStart', 10, { nodeId: gone, direction: 'up', fromFloor: '3F', toFloor: '4F' }), client);
      await markerRepository.insert(session, marker('stairEnd', 20, { direction: 'up', fromFloor: '3F', toFloor: '4F' }), client);
      await markerRepository.insert(session, marker('sessionEnd', 30, { buildingId: '북악관', floor: '4f' }), client);
      await markerRepository.insert(session, marker('stop', 40, {}), client); // older app: nothing extra
      await client.query('DELETE FROM mobility.network_nodes WHERE id = $1', [gone]); // the editor merged it away

      const anchors = await markerRepository.nodeAnchors(session, client);
      assert.deepEqual(anchors.map((a) => [a.nodeId, a.x, a.z, a.current]), [[n1, 200000, 140.5, true], [gone, 200020, 143.5, false]]);
      const listed = await markerRepository.findBySession(session, client);
      assert.deepEqual(listed.map((m) => m.floor), ['3F', null, null, '4F', null]);
      assert.deepEqual(listed.map((m) => m.node), [{ x: 200000, y: 552000, z: 140.5, current: true }, { x: 200020, y: 552000, z: 143.5, current: false }, null, null, null]);

      const view = await sessionRepository.findView(session, client);
      assert.deepEqual(trainingLabel(view!.anchorMarkers!), { valid: true, problems: [], anchors: 4, nodeAnchors: 2 });

      const { nodes } = await loadAnchorNodes({ latitude: 37.5, longitude: 127.0 }, client);
      const picked = pickAnchorNodes(nodes, { buildingId: '북악관', floor: '3F', includeUnknownFloor: false, limit: 10 });
      assert.deepEqual(picked.map((n) => n.nodeId).sort(), [n1, n2].sort());
      assert.ok(picked.every((n) => n.label === '복도' && n.heightM === 140.5 && n.distanceM !== null));
    } finally {
      await client?.query('ROLLBACK');
      client?.release();
      await pool.end();
    }
  });
