// Beacon registry, config API, admin API and beacon.observations.v1 ingestion against a disposable PostGIS DB
// (BEACON_TEST_DATABASE_URL, name ending in _test). Never defaults to .env DATABASE_URL.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { Server } from 'socket.io';
import { io } from 'socket.io-client';

test('beacon registry CRUD + uniqueness, config ETag, admin auth, WS ingestion, duplicates, legacy clients, fusion input',
  { skip: !process.env.BEACON_TEST_DATABASE_URL, timeout: 90_000 }, async () => {
    const url = new URL(process.env.BEACON_TEST_DATABASE_URL!);
    assert.match(url.pathname, /_test$/, 'Use a disposable database whose name ends in _test');
    process.env.DATABASE_URL = url.toString();
    const suffix = randomUUID().slice(0, 6).toUpperCase();
    const adminCode = `BA${suffix}`, userCode = `BU${suffix}`;
    process.env.POSITIONING_ADMIN_COLLECTORS = `${adminCode},OTHER`;
    const { pool } = await import('../src/config/database.js');
    const { migrate } = await import('../src/db/migrator.js');
    const { signAccessToken } = await import('../src/common/auth/jwt.js');
    const { registerRawCollectorGateway } = await import('../src/realtime/raw-ws.gateway.js');
    const { registerCollectorGateway } = await import('../src/realtime/collector.gateway.js');
    const { registerPreviewGateway } = await import('../src/realtime/preview.gateway.js');
    const { createApp } = await import('../src/app.js');
    const { loadFusionBeacons } = await import('../src/modules/positioning/beacon-fusion-input.js');
    const { fusionRepository } = await import('../src/modules/fusion/fusion.repository.js');
    const { summarizeReplayInput } = await import('../src/modules/fusion/fusion.replay-input.js');
    const { replaySession } = await import('../src/modules/fusion/fusion.service.js');
    const { walk, T0 } = await import('./helpers/walk.js');
    const { localToWgs84 } = await import('../src/geo/local-to-wgs84.js');
    const { tmForward } = await import('../src/geo/tm.js');

    const server = http.createServer(createApp());
    const socketServer = new Server(server, { destroyUpgrade: false });
    const wss = registerRawCollectorGateway(server);
    registerCollectorGateway(socketServer);
    registerPreviewGateway(socketServer);
    const sockets: WebSocket[] = [];
    const sio: ReturnType<typeof io>[] = [];
    try {
      await migrate();
      const mk = async (code: string, deviceName: string) => {
        const c = randomUUID(), d = randomUUID();
        await pool.query('INSERT INTO collectors(id,collector_code) VALUES($1,$2)', [c, code]);
        await pool.query('INSERT INTO devices(id,collector_id,client_device_id) VALUES($1,$2,$3)', [d, c, deviceName]);
        return { collectorId: code, collectorDatabaseId: c, deviceDatabaseId: d, clientDeviceId: deviceName };
      };
      const admin = await mk(adminCode, `admin-${suffix}`), user = await mk(userCode, `user-${suffix}`);
      const session = randomUUID(), clientSession = randomUUID(), foreign = randomUUID();
      await pool.query(`INSERT INTO collection_sessions(id,client_session_id,collector_id,device_id,started_at,status) VALUES($1,$2,$3,$4,$5,'FINISHED')`,
        [session, clientSession, user.collectorDatabaseId, user.deviceDatabaseId, '2026-10-15T01:00:00Z']);
      await pool.query(`INSERT INTO collection_sessions(id,client_session_id,collector_id,device_id,started_at,status) VALUES($1,$2,$3,$4,$5,'FINISHED')`,
        [foreign, randomUUID(), admin.collectorDatabaseId, admin.deviceDatabaseId, '2026-10-15T01:00:00Z']);
      const adminToken = signAccessToken(admin), userToken = signAccessToken(user);
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      const api = async (method: string, p: string, token: string | null, body?: unknown, headers: Record<string, string> = {}) => {
        const r = await fetch(`${base}/api/v1/positioning${p}`, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
        return { status: r.status, etag: r.headers.get('etag'), body: r.status === 304 ? null : await r.json() as any };
      };

      // ---- config API: auth, version, ETag ----
      assert.equal((await api('GET', '/beacon-config', null)).status, 401);
      const empty = await api('GET', '/beacon-config', userToken);
      assert.equal(empty.status, 200);
      assert.equal(empty.body.schemaVersion, 1);
      assert.deepEqual(empty.body.coordinateSystem.horizontal, 'EPSG:5186');
      assert.deepEqual(empty.body.features, { scanning: true, upload: true, fusion: true, floorCorrection: false });
      assert.equal((await api('GET', '/beacon-config', userToken, undefined, { 'If-None-Match': empty.etag! })).status, 304);

      // ---- admin: authorization ----
      const UUID = randomUUID().toUpperCase(); // per run: the test DB keeps earlier runs' registry rows
      const anchor = { buildingId: 'B07', floor: '3f', floorHeightM: 148.2, position: { x: 201100, y: 557250, z: 150.7 }, horizontalAccuracyM: 0.5 };
      assert.equal((await api('POST', '/admin/beacons', userToken, { uuid: UUID, major: 1, minor: 2 })).body.error.code, 'POSITIONING_ADMIN_REQUIRED');
      assert.equal((await api('GET', '/admin/beacons', userToken)).status, 403);

      // ---- admin: create, uniqueness, update, link, disable ----
      const b1 = await api('POST', '/admin/beacons', adminToken, { uuid: UUID, major: 1, minor: 2, measuredPowerDbm: -59, anchor, label: '3F hall' });
      assert.equal(b1.status, 201);
      assert.equal(b1.body.uuid, UUID.toLowerCase());
      assert.equal(b1.body.anchor.floor, '3F');
      const dup = await api('POST', '/admin/beacons', adminToken, { uuid: UUID.toLowerCase(), major: 1, minor: 2 });
      assert.deepEqual([dup.status, dup.body.error.code, dup.body.error.details.beaconId], [409, 'BEACON_EXISTS', b1.body.beaconId]);
      assert.equal((await api('POST', '/admin/beacons', adminToken, { uuid: UUID, major: 70000, minor: 2 })).status, 400);
      const b2 = await api('POST', '/admin/beacons', adminToken, { uuid: UUID, major: 1, minor: 3 });
      assert.equal(b2.body.anchor, null);
      const linked = await api('PUT', `/admin/beacons/${b2.body.beaconId}/anchor`, adminToken, { anchorId: b1.body.anchor.anchorId });
      assert.equal(linked.body.anchor.anchorId, b1.body.anchor.anchorId);
      const b3 = await api('POST', '/admin/beacons', adminToken, { uuid: UUID, major: 1, minor: 4, anchorId: b1.body.anchor.anchorId });
      const patched = await api('PATCH', `/admin/beacons/${b1.body.beaconId}`, adminToken, { label: 'renamed', measuredPowerDbm: -61 });
      assert.deepEqual([patched.body.label, patched.body.measuredPowerDbm], ['renamed', -61]);
      assert.equal((await api('PATCH', `/admin/beacons/${b1.body.beaconId}`, adminToken, { uuid: UUID })).status, 400, 'identity is immutable');
      assert.equal((await api('PATCH', `/admin/beacons/${randomUUID()}`, adminToken, { label: 'x' })).status, 404);
      const disabled = await api('DELETE', `/admin/beacons/${b3.body.beaconId}`, adminToken);
      assert.deepEqual([disabled.status, disabled.body.enabled, Boolean(disabled.body.disabledAt)], [200, false, true]);
      assert.equal((await api('GET', `/admin/beacons/${b3.body.beaconId}`, adminToken)).body.enabled, false, 'soft delete keeps the row');
      assert.equal((await api('PUT', '/admin/calibrations', adminToken, { beaconId: b1.body.beaconId, platform: 'android', deviceGroup: 'Pixel 8',
        measuredPower1m: -63, pathLossExponent: 2.3, rssiVariance: 25, sampleCount: 40 })).status, 200);
      await api('PUT', '/admin/calibrations', adminToken, { platform: 'ios', measuredPower1m: -60, pathLossExponent: 2.1, rssiVariance: 30 });
      const moved = await api('PATCH', `/admin/anchors/${b1.body.anchor.anchorId}`, adminToken, { position: { x: 201101, y: 557250, z: 150.7 } });
      assert.equal(moved.body.position.x, 201101);
      const listed = await api('GET', '/admin/beacons?includeDisabled=true', adminToken);
      assert.ok(listed.body.beacons.length >= 3);

      // ---- config reflects the registry: enabled only, version bumped, old ETag invalid ----
      const cfg = await api('GET', '/beacon-config', userToken, undefined, { 'If-None-Match': empty.etag! });
      assert.equal(cfg.status, 200);
      assert.ok(cfg.body.configVersion > empty.body.configVersion);
      const ids = cfg.body.beacons.map((b: any) => b.beaconId);
      assert.ok(ids.includes(b1.body.beaconId) && ids.includes(b2.body.beaconId) && !ids.includes(b3.body.beaconId));
      assert.ok(cfg.body.proximityUuids.includes(UUID.toLowerCase()));
      const c1 = cfg.body.beacons.find((b: any) => b.beaconId === b1.body.beaconId);
      assert.ok(Math.abs(c1.anchor.latitude - 37.6) < 0.1 && c1.calibrations[0].deviceGroup === 'Pixel 8');
      assert.ok(cfg.body.defaultCalibrations.some((c: any) => c.platform === 'ios'));

      // ---- ingestion over the raw WebSocket ----
      const ws = new WebSocket(`${base.replace('http', 'ws')}/ws/collector`, { headers: { Authorization: `Bearer ${userToken}`, 'X-Device-ID': user.clientDeviceId } });
      sockets.push(ws);
      await once(ws, 'open');
      const send = async (type: string, payload: unknown) => {
        const received = once(ws, 'message');
        ws.send(JSON.stringify({ requestId: randomUUID(), type, payload }));
        return JSON.parse((await received)[0].toString());
      };
      const at = (s: number) => new Date(Date.parse('2026-10-15T01:00:00Z') + s * 1000).toISOString();
      const ob = (minor: number, s: number, rssi = -70, id = randomUUID()) => ({ observationId: id, protocol: 'IBEACON', uuid: UUID, major: 1, minor, rssiDbm: rssi, observedAt: at(s) });
      const batch = (observations: unknown[], over: Record<string, unknown> = {}) =>
        ({ schemaVersion: 1, sessionId: session, batchId: randomUUID(), platform: 'ios', deviceModel: 'iPhone15,2', observations, ...over });
      const known = ob(2, 1), again = ob(2, 2);
      const first = batch([known, again, ob(3, 3), ob(4, 4), ob(9, 5), { ...ob(2, 6), rssiDbm: 0 }, { ...ob(2, 7), observedAt: '2019-01-01T00:00:00Z' }, known]);
      const ack = await send('beacon.observations.v1', first);
      assert.equal(ack.ok, true, JSON.stringify(ack));
      assert.deepEqual([ack.data.received, ack.data.inserted, ack.data.registered, ack.data.unregistered, ack.data.disabled, ack.data.rejectedCount, ack.data.duplicate],
        [8, 5, 3, 1, 1, 3, false]);
      assert.deepEqual(ack.data.rejected.map((r: any) => r.reason).sort(), ['DUPLICATE_IN_BATCH', 'RSSI_OUT_OF_RANGE', 'TIMESTAMP_IMPLAUSIBLE']);
      // same batchId again (lost ACK): nothing new, first receivedAt
      const retry = await send('beacon:observations.v1', first);
      assert.deepEqual([retry.data.duplicate, retry.data.inserted, retry.data.receivedAt], [true, 0, ack.data.receivedAt]);
      // same observations in a NEW batch: stored once (observationId is the row key)
      const rebatched = await send('beacon.observations.v1', batch([known, ob(2, 8)]));
      assert.deepEqual([rebatched.data.inserted, rebatched.data.duplicateObservations], [1, 1]);
      // the batchId of another session -> conflict; a foreign session -> forbidden; an unknown clientSessionId -> retry after start
      const conflict = await send('beacon.observations.v1', { ...batch([ob(2, 9)]), batchId: first.batchId, sessionId: undefined, clientSessionId: clientSession });
      assert.equal(conflict.ok, true, 'clientSessionId resolves to the same session: a plain duplicate');
      await pool.query(`INSERT INTO collection_sessions(id,client_session_id,collector_id,device_id,started_at,status) VALUES($1,$2,$3,$4,now(),'ACTIVE')`,
        [randomUUID(), randomUUID(), user.collectorDatabaseId, user.deviceDatabaseId]);
      const other = (await pool.query<{ id: string }>(`SELECT id FROM collection_sessions WHERE collector_id=$1 AND id<>$2 LIMIT 1`, [user.collectorDatabaseId, session])).rows[0].id;
      assert.equal((await send('beacon.observations.v1', { ...first, sessionId: other })).error.code, 'BATCH_SESSION_CONFLICT');
      assert.equal((await send('beacon.observations.v1', batch([ob(2, 10)], { sessionId: foreign }))).error.code, 'SESSION_FORBIDDEN');
      const notStarted = await send('beacon.observations.v1', batch([ob(2, 10)], { sessionId: undefined, clientSessionId: randomUUID() }));
      assert.deepEqual([notStarted.error.code, notStarted.error.retryable], ['SESSION_NOT_STARTED', true]);
      const invalid = await send('beacon.observations.v1', { ...batch([ob(2, 11)]), schemaVersion: 9 });
      assert.deepEqual([invalid.error.code, invalid.error.retryable], ['VALIDATION_ERROR', false]);
      assert.equal((await send('beacon.observations.v2', batch([ob(2, 11)]))).error.code, 'UNKNOWN_TYPE');

      // ---- Socket.IO transport (dot alias) ----
      const client = io(`${base}/collector`, { auth: { token: userToken, deviceId: user.clientDeviceId }, transports: ['websocket'] });
      sio.push(client);
      await new Promise<void>((resolve) => client.once('connect', () => resolve()));
      const sAck = await client.emitWithAck('beacon.observations.v1', batch([ob(2, 12)], { platform: 'android' }));
      assert.deepEqual([sAck.ok, sAck.inserted, sAck.registered], [true, 1, 1]);

      // ---- persistence: resolution, last_observed_at, raw rows untouched by registry changes ----
      const rows = (await pool.query(`SELECT resolution, count(*)::int n FROM positioning.beacon_observations WHERE session_id=$1 GROUP BY 1 ORDER BY 1`, [session])).rows;
      assert.deepEqual(rows, [{ resolution: 'DISABLED', n: 1 }, { resolution: 'REGISTERED', n: 5 }, { resolution: 'UNREGISTERED', n: 1 }]);
      assert.ok((await api('GET', `/admin/beacons/${b1.body.beaconId}`, adminToken)).body.lastObservedAt);

      // ---- fusion input: registered + enabled + anchored only, RSSI model resolved, input hash follows the registry ----
      let fusion = await loadFusionBeacons(session);
      assert.equal(fusion.length, 5);
      assert.ok(fusion.every((b) => b.anchorX === 201101 && b.floor === '3F'));
      // android row with deviceModel iPhone15,2 (batch default): no Pixel 8 / android / '*' row -> the beacon's advertised -61
      assert.equal(fusion.find((b) => b.platform === 'android')!.measuredPower1m, -61);
      assert.ok(fusion.filter((b) => b.platform === 'ios').every((b) => b.measuredPower1m === -60), 'global ios calibration');
      const raw1 = await fusionRepository.loadRawSamples(session);
      assert.equal(raw1.beacons?.length, 5);
      await api('PATCH', `/admin/anchors/${b1.body.anchor.anchorId}`, adminToken, { position: { x: 201105, y: 557250, z: 150.7 } });
      const raw2 = await fusionRepository.loadRawSamples(session);
      assert.notEqual(summarizeReplayInput(raw1, null).hash, summarizeReplayInput(raw2, null).hash, 'moving an anchor changes the replay input');
      await api('DELETE', `/admin/beacons/${b2.body.beaconId}`, adminToken);
      fusion = await loadFusionBeacons(session);
      assert.ok(fusion.every((b) => b.beaconId === b1.body.beaconId), 'a disabled beacon leaves every later replay');

      // ---- legacy client: telemetry and session:start unchanged, the new feature only advertised ----
      const start = await send('session:start', { clientSessionId: randomUUID(), deviceId: user.clientDeviceId, platform: 'ios', sensorCapabilities: {} });
      assert.ok(start.ok && start.data.supportedTelemetryFeatures.includes('absoluteAltitudeV1') && start.data.supportedTelemetryFeatures.includes('beaconObservationsV1'));
      const telemetry = await send('telemetry:batch', { batchId: randomUUID(), sessionId: session, locations: [{ sequence: 0, timestamp: at(1), latitude: 37.6, longitude: 127 }] });
      assert.equal(telemetry.ok, true);

      // ---- published replay with beacons: rows, new fused_positions columns, run metrics ----
      const replayed = randomUUID();
      await pool.query(`INSERT INTO collection_sessions(id,client_session_id,collector_id,device_id,started_at,status) VALUES($1,$2,$3,$4,$5,'FINISHED')`,
        [replayed, randomUUID(), user.collectorDatabaseId, user.deviceDatabaseId, new Date(T0).toISOString()]);
      const raw = walk(60);
      assert.equal((await send('telemetry:batch', { batchId: randomUUID(), sessionId: replayed, locations: raw.locations,
        motion: raw.motion.map((m: any) => ({ sequence: m.sequence, timestamp: m.timestamp, sensorSegmentId: m.segment, userAcceleration: { x: m.ax, y: m.ay, z: m.az },
          gravity: { x: m.gx, y: m.gy, z: m.gz }, attitude: { yaw: m.yaw, roll: 0, pitch: 0 }, rotationRate: { x: 0, y: 0, z: 0 } })),
        altimeter: raw.altimeter.map((a: any) => ({ sequence: a.sequence, timestamp: a.timestamp, relativeAltitude: a.relativeAltitude, sensorSegmentId: a.segment })),
        pedometer: raw.pedometer.map((p: any) => ({ timestamp: p.timestamp, numberOfSteps: p.numberOfSteps, distance: p.distance, sensorSegmentId: p.segment })) })).ok, true);
      const ll = localToWgs84({ latitude: 37.6158, longitude: 127.0118, height: 0 }, { x: 0, y: 12, z: 0 });
      const g = tmForward(ll.latitude, ll.longitude);
      const walkBeacon = await api('POST', '/admin/beacons', adminToken, { uuid: UUID, major: 2, minor: 1,
        anchor: { buildingId: 'outdoor', floor: '1F', floorHeightM: 60, position: { x: g.x, y: g.y, z: 62.5 } } });
      assert.equal(walkBeacon.status, 201);
      const walkObs = Array.from({ length: 50 }, (_, i) => ({ observationId: randomUUID(), protocol: 'IBEACON', uuid: UUID, major: 2, minor: 1,
        rssiDbm: Math.round(-59 - 22 * Math.log10(Math.max(1.5, Math.abs(12 - i * 0.75)))), observedAt: new Date(T0 + 5000 + i * 1000).toISOString(), sampleCount: 10 }));
      assert.equal((await send('beacon.observations.v1', batch(walkObs, { sessionId: replayed }))).data.registered, 50);
      const run = await replaySession(replayed, 'fusion-v4', 'api');
      assert.ok(run.published && run.outputs.length > 10);
      assert.equal((run.replay.input.counts as any).beacons, 50);
      const cols = (await pool.query(`SELECT count(*) FILTER (WHERE beacon_updates > 0)::int used, count(*) FILTER (WHERE floor_label = '1F')::int floor,
        count(*)::int n FROM fused_positions WHERE session_id=$1 AND algorithm_version='fusion-v4'`, [replayed])).rows[0];
      assert.ok(cols.used > 0 && cols.floor > 0 && cols.n === run.outputs.length, JSON.stringify(cols));
      const view = await fetch(`${base}/api/v1/sessions/${replayed}/fused-positions?algorithmVersion=fusion-v4`).then((r) => r.json()) as any;
      const rowsView = Array.isArray(view) ? view : view.positions ?? view.items ?? [];
      assert.ok(rowsView.some((p: any) => p.beaconUpdates > 0 && p.floorLabel === '1F'), 'REST view carries the new columns');
    } finally {
      for (const c of sio) c.close();
      for (const w of sockets) w.close();
      wss.close();
      socketServer.close();
      server.close();
      await pool.end();
    }
  });
