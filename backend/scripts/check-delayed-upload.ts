/**
 * Integration check: local-first / delayed upload against a running server, over the raw WebSocket.
 * Creates test sessions for a test device and deletes them at the end (unless --keep).
 *
 *   npm run check:delayed-upload -- [--server http://127.0.0.1:3000] [--collector C02] [--keep]
 *
 * Scenarios: A disconnect + reconnect + backlog (same session), B out-of-order batches, C duplicate batch x3,
 * D late upload after finish, E resume after a (simulated) server restart, I session started fully offline,
 * plus diagnostic events, timestamp sanity and session ownership.
 */
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import WebSocket from 'ws';
import { env } from '../src/config/env.js';
import { pool } from '../src/config/database.js';

const { values: args } = parseArgs({
  options: {
    server: { type: 'string', default: `http://127.0.0.1:${env.PORT}` },
    collector: { type: 'string', default: 'C02' },
    other: { type: 'string', default: 'C03' },
    keep: { type: 'boolean', default: false },
  },
});
const S = args.server!;
let failures = 0;
const check = (name: string, pass: boolean, detail?: unknown) => {
  if (!pass) failures++;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : '  ' + JSON.stringify(detail)}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Ack = { ok: boolean; requestId: string | null; replyTo?: string; data?: any; error?: any };

async function login(collectorId: string, deviceId: string) {
  const res = await fetch(`${S}/api/v1/collectors/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ collectorId, deviceId, platform: 'ios', deviceModel: 'delayed-check', appVersion: 'check' }),
  });
  return (await res.json()) as { accessToken: string; webSocketURL: string };
}

async function connect(l: { accessToken: string; webSocketURL: string }, deviceId: string) {
  const ws = new WebSocket(l.webSocketURL, { headers: { Authorization: `Bearer ${l.accessToken}`, 'X-Device-ID': deviceId } });
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  const pending = new Map<string, (a: Ack) => void>();
  ws.on('message', (raw) => {
    const a = JSON.parse(raw.toString()) as Ack;
    if (a.requestId) pending.get(a.requestId)?.(a);
  });
  return {
    ws,
    req(type: string, payload: unknown): Promise<Ack> {
      const requestId = randomUUID();
      return new Promise((resolve, reject) => {
        pending.set(requestId, resolve);
        ws.send(JSON.stringify({ requestId, type, payload }));
        setTimeout(() => reject(new Error(`no ACK for ${type}`)), 15_000);
      });
    },
    close: () => new Promise<void>((r) => (ws.once('close', () => r()), ws.close())),
  };
}

const BASE = Date.now() - 30 * 60_000; // data captured 30 minutes ago, uploaded now
const iso = (s: number) => new Date(BASE + s * 1000).toISOString();
const seqs = { loc: 0, mot: 0, alt: 0 };

/** Sensor data for [t0, t1) seconds: 1 Hz location + altimeter, 10 Hz motion, pedometer every 2 s (cumulative 0.7 m/s). */
function batch(ref: { sessionId?: string; clientSessionId: string }, t0: number, t1: number, extra: object = {}) {
  const locations = [];
  const motion = [];
  const altimeter = [];
  const pedometer = [];
  for (let t = t0; t < t1; t++) {
    locations.push({ sequence: t, timestamp: iso(t), latitude: 37.5665 + t * 1e-6, longitude: 126.978 + t * 1e-6, altitude: 40, ellipsoidalAltitude: 63.5, horizontalAccuracy: 6, verticalAccuracy: 8, speed: 1.2, course: 45 });
    altimeter.push({ sequence: t, timestamp: iso(t + 0.5), relativeAltitude: t * 0.01, pressure: 101.2 });
    for (let k = 0; k < 10; k++) motion.push({ sequence: t * 10 + k, timestamp: iso(t + k / 10), userAcceleration: { x: 0.3, y: 0, z: 0 }, attitude: { roll: 0, pitch: 0, yaw: 0 } });
    if (t % 2 === 0) pedometer.push({ timestamp: iso(t + 0.9), numberOfSteps: t * 2, distance: t * 0.7 });
  }
  seqs.loc += locations.length;
  return { batchId: randomUUID(), ...ref, createdAt: new Date().toISOString(), locations, motion, altimeter, pedometer, appState: 'BACKGROUND', captureSource: 'LIVE', ...extra };
}

const getSession = async (id: string) => (await (await fetch(`${S}/api/v1/sessions/${id}`)).json()) as any;
const count = async (table: string, sessionId: string) =>
  (await pool.query<{ n: number }>(`SELECT count(*) AS n FROM ${table} WHERE session_id = $1`, [sessionId])).rows[0].n;

async function waitFinalized(id: string, timeoutMs = 45_000) {
  const until = Date.now() + timeoutMs;
  let s = await getSession(id);
  while (Date.now() < until && !(s.syncState === 'FINALIZED' && s.fusion.state === 'CLEAN')) {
    await sleep(1000);
    s = await getSession(id);
  }
  return s;
}

async function main() {
  const deviceId = `DELAYED-TEST-${randomUUID().slice(0, 8)}`;
  const l = await login(args.collector!, deviceId);
  const created: string[] = [];

  // ---------- A: disconnect / reconnect / backlog ----------
  const clientSessionId = randomUUID();
  let c = await connect(l, deviceId);
  const start = await c.req('session:start', { clientSessionId, deviceId, clientStartedAt: iso(0), sensorCapabilities: { location: true } });
  const sessionId = start.data.sessionId as string;
  created.push(sessionId);
  check('A start: new session, startedAt = client time', start.ok && start.data.resumed === false && Date.parse(start.data.startedAt) === Date.parse(iso(0)), start.data);
  const b1 = await c.req('telemetry:batch', batch({ sessionId, clientSessionId }, 0, 10));
  check('A first live batch stored', b1.ok && b1.replyTo === b1.requestId);
  await c.close(); // network lost; the phone keeps capturing locally
  c = await connect(l, deviceId); // network back
  const resumed = await c.req('session.start', { clientSessionId, deviceId }); // dot-style alias
  check('A reconnect: same session (resumed)', resumed.ok && resumed.data.sessionId === sessionId && resumed.data.resumed === true);
  for (let t = 10; t < 310; t += 60) {
    const r = await c.req('telemetry:batch', batch({ clientSessionId }, t, t + 60)); // backlog, clientSessionId only
    if (!r.ok) check(`A backlog batch ${t}`, false, r.error);
  }
  check('A backlog stored once (310 locations, 3100 motion)', (await count('location_samples', sessionId)) === 310 && (await count('motion_samples', sessionId)) === 3100);
  check('A still exactly one session for the clientSessionId', (await pool.query('SELECT 1 FROM collection_sessions WHERE client_session_id = $1', [clientSessionId])).rowCount === 1);

  // ---------- B: out-of-order batches ----------
  for (const [t0, t1] of [[310, 320], [340, 350], [320, 330], [330, 340]]) await c.req('telemetry:batch', batch({ sessionId, clientSessionId }, t0, t1));
  const sB = await getSession(sessionId);
  check('B out-of-order arrivals stored and fusion marked DIRTY', sB.outOfOrderBatches >= 1 && sB.fusion.state === 'DIRTY' && sB.needsReprocess === true, { ooo: sB.outOfOrderBatches, fusion: sB.fusion });
  const locs = (await (await fetch(`${S}/api/v1/sessions/${sessionId}/locations`)).json()) as { timestamp: string }[];
  check('B locations API in sensor-time order', locs.every((p, i) => i === 0 || Date.parse(locs[i - 1].timestamp) <= Date.parse(p.timestamp)) && locs.length === 350);

  // ---------- C: duplicate batch x3 ----------
  const dup = batch({ sessionId, clientSessionId }, 350, 360);
  const acks = [await c.req('telemetry:batch', dup), await c.req('telemetry:batch', dup), await c.req('telemetry:batch', dup)];
  check('C duplicate batch x3: all ACK ok, stored once', acks.every((a) => a.ok) && acks[1].data.duplicate && acks[2].data.duplicate && (await count('location_samples', sessionId)) === 360);
  const overlap = await c.req('telemetry:batch', { ...batch({ sessionId, clientSessionId }, 355, 365) }); // new batchId, half already stored
  check('C sample-level dedupe across batches', overlap.ok && (await count('location_samples', sessionId)) === 365);

  // ---------- D: finish, then late upload ----------
  const fin = await c.req('session:finish', { clientSessionId, endedAt: iso(370) });
  check('D finish ok (clientSessionId only)', fin.ok && fin.data.collectionState === 'FINISHED');
  await sleep(1500);
  const late = await c.req('telemetry:batch', batch({ sessionId, clientSessionId }, 365, 370, { captureSource: 'HISTORICAL_RECOVERY' }));
  const sD = await getSession(sessionId);
  check('D late batch after finish accepted, fusion DIRTY, not finalized', late.ok && sD.fusion.state === 'DIRTY' && sD.syncState !== 'FINALIZED', { sync: sD.syncState, fusion: sD.fusion });

  // ---------- E: resume after a (simulated) server restart: new connection, same clientSessionId ----------
  await c.close();
  c = await connect(l, deviceId);
  const e = await c.req('session:start', { clientSessionId, deviceId });
  check('E new connection + same clientSessionId => same session, no new row', e.ok && e.data.sessionId === sessionId && e.data.resumed === true);

  console.log(`      waiting for debounced final replay (idle ${env.SESSION_REPROCESS_IDLE_DELAY_MS} ms)…`);
  const fA = await waitFinalized(sessionId);
  check('A/D final replay => FINALIZED + fusion CLEAN', fA.syncState === 'FINALIZED' && fA.fusion.state === 'CLEAN' && !fA.needsReprocess, { sync: fA.syncState, fusion: fA.fusion });
  const fusedOrdered = (await pool.query<{ ok: boolean }>(
    `SELECT bool_and(ts >= prev) AS ok FROM (SELECT "timestamp" ts, lag("timestamp") OVER (ORDER BY fusion_sequence) prev FROM fused_positions WHERE session_id = $1 AND algorithm_version = $2) x WHERE prev IS NOT NULL`,
    [sessionId, env.ACTIVE_FUSION_VERSION],
  )).rows[0].ok;
  check('final fused trajectory is chronological', fusedOrdered === true);
  const detail = await getSession(sessionId);
  const loc = detail.raw.streams.find((s: any) => s.stream === 'location');
  check('detail raw stats: counts, recovered samples, upload delay', loc.count === 370 && loc.recovered === 5 && detail.raw.streams.every((s: any) => s.maxReceiveDelaySeconds >= 60 * 29), loc);

  // ---------- I: session started fully offline ----------
  const offlineId = randomUUID();
  const early = await c.req('telemetry:batch', batch({ clientSessionId: offlineId }, 0, 5));
  check('I backlog before session:start => retryable SESSION_NOT_STARTED', !early.ok && early.error.code === 'SESSION_NOT_STARTED' && early.error.retryable === true, early.error?.code);
  const st = await c.req('session:start', { clientSessionId: offlineId, deviceId, clientStartedAt: iso(0) });
  created.push(st.data.sessionId);
  const sI = await getSession(st.data.sessionId);
  check('I offline session: started_at = client start, created_at = now', st.ok && st.data.resumed === false && Date.parse(sI.startedAt) === Date.parse(iso(0)) && Date.parse(sI.createdAt) > Date.parse(iso(60)));
  for (let t = 0; t < 120; t += 40) await c.req('telemetry:batch', batch({ clientSessionId: offlineId }, t, t + 40));
  const mk = await c.req('marker:create', { markerId: randomUUID(), clientSessionId: offlineId, timestamp: iso(50), type: 'entrance', latitude: 37.5666, longitude: 126.978 });
  check('I marker with clientSessionId only', mk.ok);
  const ev = { eventId: randomUUID(), eventType: 'APP_BACKGROUND', clientTimestamp: iso(30), metadata: { reason: 'screen locked' } };
  const ev1 = await c.req('diagnostic.event', { clientSessionId: offlineId, events: [ev, { eventType: 'MOTION_STOPPED', clientTimestamp: iso(31) }] });
  const ev2 = await c.req('diagnostic:event', { clientSessionId: offlineId, ...ev });
  check('diagnostic events stored, resend deduplicated by eventId', ev1.ok && ev1.data.inserted === 2 && ev2.ok && ev2.data.duplicates === 1);
  const dg = await c.req('session:diagnostics', { clientSessionId: offlineId, diagnostics: { backgroundDuration: 600, backgroundTransitionCount: 2, lowPowerModeObserved: false } });
  check('session diagnostics merged', dg.ok);
  const finI = await c.req('session:finish', { clientSessionId: offlineId, endedAt: iso(120), interrupted: true, lastSequences: { location: 119, motion: 1199, altimeter: 119, pedometer: -1 } });
  check('I finish with manifest => synchronized', finI.ok && finI.data.sync?.synchronized === true, finI.data.sync);
  const fI = await waitFinalized(st.data.sessionId, 20_000);
  check('I synchronized session finalized right away (no idle wait), interrupted kept', fI.syncState === 'FINALIZED' && fI.interrupted === true && fI.fusion.state === 'CLEAN', { sync: fI.syncState });
  const sc = await c.req('session.syncComplete', { clientSessionId: offlineId, lastSequences: { location: 500 } });
  check('syncComplete reports a missing stream tail', sc.ok && sc.data.synchronized === false && sc.data.streams.location.server === 119);

  // ---------- validation & ownership ----------
  const bad = await c.req('telemetry:batch', { batchId: randomUUID(), clientSessionId: offlineId, locations: [{ sequence: 999, timestamp: '2010-01-01T00:00:00Z', latitude: 37, longitude: 127 }] });
  check('implausible timestamp (2010) rejected, not retryable', !bad.ok && bad.error.code === 'VALIDATION_ERROR' && bad.error.retryable === false);
  const otherDevice = `DELAYED-TEST-${randomUUID().slice(0, 8)}`;
  const o = await connect(await login(args.other!, otherDevice), otherDevice);
  const steal = await o.req('telemetry:batch', batch({ clientSessionId }, 400, 401));
  check("another collector cannot write into this session", !steal.ok && steal.error.code === 'SESSION_FORBIDDEN', steal.error?.code);
  await o.close();
  await c.close();

  if (!args.keep) {
    await pool.query("DELETE FROM collection_sessions WHERE device_id IN (SELECT id FROM devices WHERE client_device_id LIKE 'DELAYED-TEST-%')");
    await pool.query("DELETE FROM devices WHERE client_device_id LIKE 'DELAYED-TEST-%'");
  }
  console.log(`\n${failures === 0 ? 'ALL PASSED' : `${failures} FAILED`}${args.keep ? `  (kept sessions ${created.join(', ')})` : '  (test data deleted)'}`);
  process.exitCode = failures ? 1 : 0;
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
