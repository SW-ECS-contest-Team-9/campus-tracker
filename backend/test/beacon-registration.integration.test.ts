// Beacon registration flow against a disposable PostGIS DB (BEACON_TEST_DATABASE_URL, name ending in _test):
// survey UUID -> apps collect unregistered major/minor -> discovered list with a suggested position -> register with
// latitude/longitude -> the earlier observations of that walk now reach fusion.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import { once } from 'node:events';

test('beacon registration: survey UUIDs, discovered beacons, WGS84 anchor input, later registration reaches fusion',
  { skip: !process.env.BEACON_TEST_DATABASE_URL, timeout: 60_000 }, async () => {
    const url = new URL(process.env.BEACON_TEST_DATABASE_URL!);
    assert.match(url.pathname, /_test$/);
    process.env.DATABASE_URL = url.toString();
    const code = `BR${randomUUID().slice(0, 6).toUpperCase()}`;
    process.env.POSITIONING_ADMIN_COLLECTORS = code;
    const { pool } = await import('../src/config/database.js');
    const { migrate } = await import('../src/db/migrator.js');
    const { signAccessToken } = await import('../src/common/auth/jwt.js');
    const { createApp } = await import('../src/app.js');
    const { beaconService } = await import('../src/modules/positioning/beacon.service.js');
    const { loadFusionBeacons } = await import('../src/modules/positioning/beacon-fusion-input.js');
    const { REALTIME_FUSION_VERSION } = await import('../src/modules/fusion/fusion.algorithms.js');
    const { tmForward } = await import('../src/geo/tm.js');
    const server = http.createServer(createApp());
    try {
      await migrate();
      const collector = randomUUID(), device = randomUUID(), session = randomUUID();
      await pool.query('INSERT INTO collectors(id,collector_code) VALUES($1,$2)', [collector, code]);
      await pool.query('INSERT INTO devices(id,collector_id,client_device_id) VALUES($1,$2,$3)', [device, collector, `reg-${code}`]);
      await pool.query(`INSERT INTO collection_sessions(id,client_session_id,collector_id,device_id,started_at,status) VALUES($1,$2,$3,$4,now() - interval '1 hour','FINISHED')`,
        [session, randomUUID(), collector, device]);
      const identity = { collectorId: code, collectorDatabaseId: collector, deviceDatabaseId: device, clientDeviceId: `reg-${code}` };
      const token = signAccessToken(identity);
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/v1/positioning`;
      const api = async (method: string, p: string, body?: unknown) => {
        const r = await fetch(`${base}${p}`, { method, headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
          body: body ? JSON.stringify(body) : undefined });
        return { status: r.status, body: await r.json() as any };
      };
      const UUID = randomUUID();

      assert.deepEqual((await api('GET', '/admin/me')).body, { collectorId: code, admin: true });
      // survey UUID: in the app config before any beacon of it is registered
      assert.equal((await api('POST', '/admin/survey-uuids', { uuid: UUID.toUpperCase(), label: '3F hall kit' })).status, 201);
      assert.ok((await api('GET', '/beacon-config')).body.proximityUuids.includes(UUID));

      // the phone walked past major 7 / minor 9; the strongest reading was at the fused position below
      const t = (s: number) => new Date(Date.now() - 30 * 60_000 + s * 1000).toISOString();
      const obs = [-80, -62, -75].map((rssi, i) => ({ observationId: randomUUID(), protocol: 'IBEACON', uuid: UUID, major: 7, minor: 9, rssiDbm: rssi, observedAt: t(i * 5) }));
      const ack = await beaconService.ingest(identity, { schemaVersion: 1, sessionId: session, batchId: randomUUID(), platform: 'android', observations: obs });
      assert.equal(ack.unregistered, 3);
      await pool.query(`INSERT INTO fused_positions(session_id,fusion_sequence,timestamp,latitude,longitude,ellipsoidal_altitude,horizontal_confidence,vertical_confidence,
        overall_confidence,position_source,algorithm_version,geom,horizontal_uncertainty,floor_label,building_id)
        VALUES($1,1,$2,37.6105,126.9971,170,1,1,1,'FUSED',$3,ST_SetSRID(ST_MakePoint(126.9971,37.6105,170),4326),2.5,'3F','B07')`,
        [session, t(5.4), REALTIME_FUSION_VERSION]);
      const discovered = (await api('GET', '/admin/discovered?sinceHours=2')).body.discovered.find((d: any) => d.uuid === UUID);
      assert.ok(discovered, 'listed for registration');
      assert.deepEqual([discovered.major, discovered.minor, discovered.observations, discovered.maxRssiDbm], [7, 9, 3, -62]);
      assert.deepEqual([discovered.suggestedPosition.latitude, discovered.suggestedPosition.floor, discovered.suggestedPosition.buildingId], [37.6105, '3F', 'B07']);
      assert.equal((await loadFusionBeacons(session)).length, 0, 'unregistered: not a measurement');

      // register with the suggested WGS84 position (stored as EPSG:5186)
      const created = await api('POST', '/admin/beacons', { uuid: UUID, major: 7, minor: 9, label: 'found on walk',
        anchor: { buildingId: 'B07', floor: '3F', position: { latitude: 37.6105, longitude: 126.9971, z: 150.2 } } });
      assert.equal(created.status, 201, JSON.stringify(created.body));
      const g = tmForward(37.6105, 126.9971);
      assert.ok(Math.abs(created.body.anchor.position.x - g.x) < 1e-6 && Math.abs(created.body.anchor.position.y - g.y) < 1e-6);
      assert.equal((await api('POST', '/admin/beacons', { uuid: UUID, major: 7, minor: 10, anchor: { buildingId: 'B07',
        position: { latitude: 10, longitude: 126.9, z: 1 } } })).status, 400, 'outside Korea');
      assert.equal((await api('POST', '/admin/beacons', { uuid: UUID, major: 7, minor: 10, anchor: { buildingId: 'B07',
        position: { latitude: 37.6, longitude: 126.9, x: 200000, z: 1 } } })).status, 400, 'one coordinate form only');
      // gone from the discovered list; the earlier walk's observations are now measurements for a reprocess
      assert.ok(!(await api('GET', '/admin/discovered?sinceHours=2')).body.discovered.some((d: any) => d.uuid === UUID));
      assert.equal((await loadFusionBeacons(session)).length, 3);

      assert.equal((await api('DELETE', `/admin/survey-uuids/${UUID}`)).status, 200);
      assert.equal((await api('DELETE', `/admin/survey-uuids/${UUID}`)).status, 404);
      assert.ok((await api('GET', '/beacon-config')).body.proximityUuids.includes(UUID), 'still scanned: a registered beacon uses it');

      // edit from the apps: label / power / placement; the beacon's own anchor is rewritten in place
      const beaconId = created.body.beaconId, anchorId = created.body.anchor.anchorId;
      const rev = (await api('GET', '/admin/beacons')).body.configVersion;
      const edited = await api('PATCH', `/admin/beacons/${beaconId}`, { label: 'hall door', measuredPowerDbm: -61,
        anchor: { buildingId: 'B07', floor: '4F', floorHeightM: 152, position: { x: 201100, y: 557250, z: 154.5 }, horizontalAccuracyM: 2 } });
      assert.equal(edited.status, 200, JSON.stringify(edited.body));
      assert.equal(edited.body.anchor.anchorId, anchorId, 'own anchor kept');
      assert.deepEqual([edited.body.label, edited.body.measuredPowerDbm, edited.body.anchor.floor, edited.body.anchor.position.z, edited.body.anchor.horizontalAccuracyM],
        ['hall door', -61, '4F', 154.5, 2]);
      assert.ok((await api('GET', '/admin/beacons')).body.configVersion > rev, 'config version bumped');
      assert.equal((await api('PATCH', `/admin/beacons/${beaconId}`, { anchorId: null, anchor: edited.body.anchor })).status, 400);
      // a shared anchor is not rewritten: the edited beacon gets a new one
      const twin = await api('POST', '/admin/beacons', { uuid: UUID, major: 7, minor: 11, anchorId });
      assert.equal(twin.status, 201);
      const moved = await api('PATCH', `/admin/beacons/${beaconId}`, { anchor: { buildingId: 'B07', position: { x: 201101, y: 557251, z: 154.5 } } });
      assert.notEqual(moved.body.anchor.anchorId, anchorId);
      assert.equal((await api('GET', `/admin/beacons/${twin.body.beaconId}`)).body.anchor.position.x, 201100);
      // disable / enable
      assert.equal((await api('PATCH', `/admin/beacons/${beaconId}`, { enabled: false })).body.enabled, false);
      assert.equal((await api('PATCH', `/admin/beacons/${beaconId}`, { enabled: true })).body.enabled, true);
      // permanent delete: observations become unregistered (discoverable again), the beacon's own anchor goes
      const movedAnchor = moved.body.anchor.anchorId;
      assert.deepEqual((await api('DELETE', `/admin/beacons/${beaconId}?permanent=true`)).body, { beaconId, deleted: true });
      assert.equal((await api('GET', `/admin/beacons/${beaconId}`)).status, 404);
      assert.equal((await api('DELETE', `/admin/beacons/${beaconId}?permanent=true`)).status, 404);
      assert.equal((await pool.query('SELECT 1 FROM positioning.spatial_anchors WHERE id = $1', [movedAnchor])).rowCount, 0);
      assert.equal((await pool.query('SELECT 1 FROM positioning.spatial_anchors WHERE id = $1', [anchorId])).rowCount, 1, 'shared anchor stays');
      const { rows: left } = await pool.query(`SELECT resolution, beacon_id FROM positioning.beacon_observations WHERE uuid = $1 AND minor = 9`, [UUID]);
      assert.deepEqual(left.map((r) => [r.resolution, r.beacon_id]), [['UNREGISTERED', null], ['UNREGISTERED', null], ['UNREGISTERED', null]]);
      assert.equal((await loadFusionBeacons(session)).length, 0);
      assert.ok((await api('GET', '/admin/discovered?sinceHours=2')).body.discovered.some((d: any) => d.uuid === UUID && d.minor === 9));
      // the default DELETE stays a soft delete
      assert.equal((await api('DELETE', `/admin/beacons/${twin.body.beaconId}`)).body.enabled, false);
      // the same identifier can be registered again
      assert.equal((await api('POST', '/admin/beacons', { uuid: UUID, major: 7, minor: 9 })).status, 201);
    } finally {
      server.close();
      await pool.end();
    }
  });
