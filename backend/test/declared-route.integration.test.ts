// Declared route stored with the session (migration 032) against a disposable PostGIS DB (FUSION_TEST_DATABASE_URL,
// name ending in _test); rolled back.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

test('declared route: stored on insert, filled on a resumed start only when missing, exposed in the session view',
  { skip: !process.env.FUSION_TEST_DATABASE_URL, timeout: 60_000 }, async () => {
    const url = new URL(process.env.FUSION_TEST_DATABASE_URL!);
    assert.match(url.pathname, /_test$/);
    process.env.DATABASE_URL = url.toString();
    const { pool } = await import('../src/config/database.js');
    const { migrate } = await import('../src/db/migrator.js');
    const { sessionRepository } = await import('../src/modules/sessions/session.repository.js');
    const { evaluateDeclaredRoute } = await import('../src/modules/mobility/declared-route.js');
    let client;
    try {
      await migrate();
      client = await pool.connect();
      await client.query('BEGIN');
      const collector = randomUUID(), device = randomUUID(), owner = `DR${collector.slice(0, 6)}`;
      await client.query('INSERT INTO collectors(id,collector_code) VALUES($1,$2)', [collector, owner]);
      await client.query('INSERT INTO devices(id,collector_id,client_device_id) VALUES($1,$2,$3)', [device, collector, 'route-test']);
      const insert = (route: unknown) => {
        const d = evaluateDeclaredRoute(route);
        return sessionRepository.insert(client!, {
          clientSessionId: randomUUID(), collectorId: collector, deviceId: device, startedAt: null, sensorCapabilities: {},
          strideCalibration: null, strideCalibrationStatus: 'FALLBACK', strideCalibrationReason: null,
          declaredRoute: d.route, declaredRouteStatus: d.status, declaredRouteReason: d.reason,
        });
      };
      const [n1, n2, n3] = [randomUUID(), randomUUID(), randomUUID()];
      const withRoute = (await insert({ nodeKeys: [n1, n2, n3], segments: [{ mode: 'elevator', fromFloor: '1F', toFloor: '5F' }], text: '1F 승강기 → 5F' }))!;
      const view = (await sessionRepository.findView(withRoute.id, client))!;
      assert.equal(view.declaredRouteStatus, 'ACCEPTED');
      assert.deepEqual(view.declaredRoute, {
        nodeKeys: [n1, n2, n3], segments: [{ mode: 'elevator', fromFloor: '1F', toFloor: '5F' }, { mode: 'walk' }], text: '1F 승강기 → 5F',
      });

      const rejected = (await insert({ nodeKeys: [n1] }))!;
      const r = (await sessionRepository.findView(rejected.id, client))!;
      assert.equal(r.declaredRoute, null);
      assert.equal(r.declaredRouteStatus, 'REJECTED');
      assert.match(r.declaredRouteReason!, /nodeKeys/);

      const none = (await insert(undefined))!;
      assert.equal((await sessionRepository.findView(none.id, client))!.declaredRouteStatus, 'NONE');
      // a resumed start fills a missing route, and never replaces a stored one
      const later = evaluateDeclaredRoute({ nodeKeys: [n2, n3] }).route!;
      await sessionRepository.fillDeclaredRoute(client, none.id, later);
      await sessionRepository.fillDeclaredRoute(client, withRoute.id, later);
      assert.deepEqual((await sessionRepository.findView(none.id, client))!.declaredRoute?.nodeKeys, [n2, n3]);
      assert.deepEqual((await sessionRepository.findView(withRoute.id, client))!.declaredRoute?.nodeKeys, [n1, n2, n3]);
      await client.query('ROLLBACK');

      // POST /api/v1/mobility/declared-route: wired, validated, read-only (nodes absent from the graph fail their leg)
      const { createApp } = await import('../src/app.js');
      const server = createApp().listen(0, '127.0.0.1');
      await new Promise<void>((resolve) => server.once('listening', resolve));
      try {
        const { port } = server.address() as { port: number };
        const post = (body: unknown) => fetch(`http://127.0.0.1:${port}/api/v1/mobility/declared-route`, {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
        const ok = await post({ nodeKeys: [n1, n2], segments: [{ mode: 'stairs', direction: 'down' }] });
        assert.equal(ok.status, 200);
        const path = await ok.json() as { reachable: boolean; legs: { reason?: string; segment: unknown }[]; geometry: { type: string } };
        assert.equal(path.reachable, false);
        assert.equal(path.legs[0].reason, 'NODE_NOT_IN_NETWORK');
        assert.deepEqual(path.legs[0].segment, { mode: 'stairs', direction: 'down' });
        assert.equal(path.geometry.type, 'LineString');
        assert.equal((await post({ nodeKeys: [n1] })).status, 400);
      } finally {
        await new Promise((resolve) => server.close(resolve));
      }
    } finally {
      await client?.query('ROLLBACK').catch(() => undefined);
      client?.release();
      await pool.end();
    }
  });
