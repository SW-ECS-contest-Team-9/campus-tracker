// Opt-in disposable PostGIS DB only; never reads the operational .env database.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

test('absolute altitude migration, raw idempotency, manifests and both replay loaders',
  { skip: !process.env.FUSION_TEST_DATABASE_URL, timeout: 60_000 }, async () => {
    const url = new URL(process.env.FUSION_TEST_DATABASE_URL!);
    assert.match(url.pathname, /_test$/);
    process.env.DATABASE_URL = url.toString();
    const { pool } = await import('../src/config/database.js');
    const { migrate } = await import('../src/db/migrator.js');
    const { telemetryRepository } = await import('../src/modules/telemetry/telemetry.repository.js');
    const { sessionRepository } = await import('../src/modules/sessions/session.repository.js');
    const { fusionRepository } = await import('../src/modules/fusion/fusion.repository.js');
    const { fusionRunsRepository } = await import('../src/modules/fusion/fusion-runs.repository.js');
    const { TelemetryBatchRequest } = await import('../src/modules/telemetry/telemetry.dto.js');
    let client;
    try {
      await migrate();
      client = await pool.connect();
      await client.query('BEGIN');
      const collector = randomUUID(), device = randomUUID(), session = randomUUID();
      await client.query('INSERT INTO collectors(id,collector_code) VALUES($1,$2)', [collector, `AA${collector.slice(0, 6)}`]);
      await client.query('INSERT INTO devices(id,collector_id,client_device_id) VALUES($1,$2,$3)', [device, collector, 'absolute-test']);
      await client.query(`INSERT INTO collection_sessions(id,client_session_id,collector_id,device_id,started_at,sensor_capabilities)
        VALUES($1,$2,$3,$4,now(),'{"absoluteAltitudeEnabled":true}')`, [session, randomUUID(), collector, device]);
      const rows = TelemetryBatchRequest.parse({ batchId: randomUUID(), sessionId: session, absoluteAltitude: [
        { sequence: 0, timestamp: new Date().toISOString(), altitude: -3, accuracy: 4, precision: 0.1, verticalReference: 'APPLE_MSL' },
        { sequence: 1, timestamp: new Date().toISOString(), altitude: null, accuracy: null, precision: null,
          verticalReference: 'APPLE_MSL', invalidReason: 'NON_FINITE_ALTITUDE' },
      ] }).absoluteAltitude!;
      assert.equal(await telemetryRepository.insertAbsoluteAltitude(client, session, rows), 2);
      assert.equal(await telemetryRepository.insertAbsoluteAltitude(client, session, rows), 0);
      assert.equal((await sessionRepository.maxSequences(session, client)).absoluteAltitude, 1);
      assert.equal(await sessionRepository.getAbsoluteAltitudeEnabled(session, client), true);
      const raw = await fusionRepository.loadRawSamples(session, client);
      assert.equal(raw.absoluteAltitude!.length, 2);
      assert.ok(raw.absoluteAltitude!.some((r) => r.altitude === -3));
      assert.ok(raw.absoluteAltitude!.some((r) => r.invalidReason === 'NON_FINITE_ALTITUDE'));
      const batches = await fusionRunsRepository.loadArrivalBatches(session, client);
      assert.equal(batches.flatMap((b) => b.absoluteAltitude ?? []).length, 2);
      const gate = { batchId: randomUUID(), sessionId: session, clientCreatedAt: null,
        counts: { locations: 0, motion: 0, altimeter: 0, pedometer: 0, absoluteAltitude: 2 },
        captureSource: null, appState: null, minCapturedAt: null, maxCapturedAt: null };
      assert.ok(await telemetryRepository.insertReceivedBatch(client, gate));
      assert.equal(await telemetryRepository.insertReceivedBatch(client, gate), null);
      const batch = (await client.query('SELECT absolute_altitude_count n FROM received_batches WHERE batch_id=$1', [gate.batchId])).rows[0];
      assert.equal(batch.n, 2);
    } finally {
      if (client) { await client.query('ROLLBACK'); client.release(); }
      await pool.end();
    }
  });
