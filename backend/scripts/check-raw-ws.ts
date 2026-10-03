/**
 * End-to-end check of the raw WebSocket endpoint (/ws/collector), the same way an iPhone with
 * URLSessionWebSocketTask uses it. Creates a short session for the given collector.
 *
 *   npm run check:raw-ws -w backend -- --server http://100.102.255.108:3000 --collector C02
 */
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import WebSocket from 'ws';
import { env } from '../src/config/env.js';

const { values: args } = parseArgs({
  options: {
    server: { type: 'string', default: `http://127.0.0.1:${env.PORT}` },
    collector: { type: 'string', default: 'C02' },
  },
});

let failures = 0;
function check(name: string, pass: boolean, detail?: unknown) {
  if (!pass) failures++;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : '  ' + JSON.stringify(detail)}`);
}

type Ack = { type: 'ack'; requestId: string | null; ok: boolean; data?: any; error?: any };

function open(url: string, headers: Record<string, string>): Promise<{ ws?: WebSocket; status?: number; body?: string }> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, { headers });
    ws.once('open', () => resolve({ ws }));
    ws.once('unexpected-response', (_req, res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    ws.once('error', () => undefined);
  });
}

function client(ws: WebSocket) {
  const pending = new Map<string, (a: Ack) => void>();
  const stray: Ack[] = [];
  ws.on('message', (raw) => {
    const ack = JSON.parse(raw.toString()) as Ack;
    const resolve = ack.requestId ? pending.get(ack.requestId) : undefined;
    if (resolve) {
      pending.delete(ack.requestId!);
      resolve(ack);
    } else stray.push(ack);
  });
  return {
    stray,
    request(type: string, payload: unknown, requestId = randomUUID()): Promise<Ack> {
      return new Promise((resolve, reject) => {
        pending.set(requestId, resolve);
        ws.send(JSON.stringify({ requestId, type, payload }));
        setTimeout(() => reject(new Error(`no ACK for ${type}`)), 10_000);
      });
    },
  };
}

async function main() {
  const loginRes = await fetch(`${args.server}/api/v1/collectors/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ collectorId: args.collector, deviceId: `RAWWS-TEST-${randomUUID().slice(0, 8)}`, platform: 'ios', deviceModel: 'raw-ws-check', appVersion: 'check' }),
  });
  const login = (await loginRes.json()) as { accessToken: string; webSocketURL: string; collectorId: string };
  check('POST /api/v1/collectors/login 200 + webSocketURL', loginRes.ok && /^wss?:\/\/.+\/ws\/collector$/.test(login.webSocketURL), login.webSocketURL);
  const deviceId = JSON.parse(Buffer.from(login.accessToken.split('.')[1], 'base64url').toString()).clientDeviceId as string;
  const auth = { Authorization: `Bearer ${login.accessToken}`, 'X-Device-ID': deviceId };

  // ---- upgrade rejections ----
  const noToken = await open(login.webSocketURL, { 'X-Device-ID': deviceId });
  check('no token → 401 TOKEN_REQUIRED', noToken.status === 401 && noToken.body!.includes('TOKEN_REQUIRED'), noToken.status);
  const badToken = await open(login.webSocketURL, { Authorization: 'Bearer nope', 'X-Device-ID': deviceId });
  check('bad token → 401 INVALID_TOKEN', badToken.status === 401 && badToken.body!.includes('INVALID_TOKEN'), badToken.status);
  const malformed = await open(login.webSocketURL, { Authorization: login.accessToken, 'X-Device-ID': deviceId });
  check('non-Bearer header → 401 INVALID_TOKEN', malformed.status === 401 && malformed.body!.includes('INVALID_TOKEN'), malformed.status);
  const otherDevice = await open(login.webSocketURL, { ...auth, 'X-Device-ID': 'SOMEONE-ELSE' });
  check('device mismatch → 403 DEVICE_MISMATCH', otherDevice.status === 403 && otherDevice.body!.includes('DEVICE_MISMATCH'), otherDevice.status);
  const noDevice = await open(login.webSocketURL, { Authorization: auth.Authorization });
  check('missing X-Device-ID → 403 DEVICE_MISMATCH', noDevice.status === 403, noDevice.status);
  const wrongPath = await open(login.webSocketURL.replace('/ws/collector', '/ws/nope'), auth);
  check('unknown ws path → 404', wrongPath.status === 404, wrongPath.status);

  // ---- happy path ----
  const { ws } = await open(login.webSocketURL, auth);
  check('upgrade with Bearer + X-Device-ID → connected', !!ws);
  if (!ws) process.exit(1);
  let c = client(ws);

  const clientSessionId = randomUUID();
  const startPayload = { clientSessionId, deviceId, platform: 'ios', deviceModel: 'raw-ws-check', systemVersion: '18.0', appVersion: 'check', sensorCapabilities: { location: true }, startedAt: new Date().toISOString() };
  const start = await c.request('session:start', startPayload);
  check('session:start ACK', start.ok && start.data.status === 'ACTIVE' && !('ok' in start.data), start.data);
  const sessionId = start.data.sessionId as string;
  const startAgain = await c.request('session:start', startPayload);
  check('session:start retry → same sessionId', startAgain.ok && startAgain.data.sessionId === sessionId);

  const now = Date.now();
  const batch = {
    batchId: randomUUID(), sessionId, clientSessionId, createdAt: new Date().toISOString(),
    locations: [1, 2, 3].map((i) => ({ sequence: i, timestamp: new Date(now + i * 1000).toISOString(), latitude: 37.5665 + i * 1e-5, longitude: 126.978, altitude: 40, ellipsoidalAltitude: 63.5, horizontalAccuracy: 4, verticalAccuracy: 6 })),
    motion: [1, 2].map((i) => ({ sequence: i, timestamp: new Date(now + i * 50).toISOString(), userAcceleration: { x: 0, y: 0, z: 0 } })),
    altimeter: [{ sequence: 1, timestamp: new Date(now).toISOString(), relativeAltitude: 0, pressure: 101.2 }],
    pedometer: [{ timestamp: new Date(now).toISOString(), numberOfSteps: 3 }],
  };
  const b1 = await c.request('telemetry:batch', batch);
  check('telemetry:batch ACK duplicate=false', b1.ok && b1.data.duplicate === false, b1.data);
  const b2 = await c.request('telemetry:batch', batch);
  check('same batchId again → duplicate=true', b2.ok && b2.data.duplicate === true);

  // ACK lost: close right after sending, reconnect, resend the same batchId
  const lostBatch = { ...batch, batchId: randomUUID(), locations: [{ ...batch.locations[0], sequence: 4 }] };
  ws.send(JSON.stringify({ requestId: randomUUID(), type: 'telemetry:batch', payload: lostBatch }));
  ws.terminate();
  await new Promise((r) => setTimeout(r, 300));
  const { ws: ws2 } = await open(login.webSocketURL, auth);
  check('reconnect after drop', !!ws2);
  c = client(ws2!);
  const resent = await c.request('telemetry:batch', lostBatch);
  check('batch resent after drop → stored once (ok)', resent.ok, resent.data);

  const markerPayload = { markerId: randomUUID(), sessionId, clientSessionId, timestamp: new Date().toISOString(), type: 'stairStart', note: null, latitude: 37.5666, longitude: 126.978, altitude: 40, ellipsoidalAltitude: 63.5, horizontalAccuracy: 3, verticalAccuracy: 5 };
  const m1 = await c.request('marker:create', markerPayload);
  const m2 = await c.request('marker:create', markerPayload);
  check('marker:create ACK + idempotent retry', m1.ok && m1.data.duplicate === false && m2.ok && m2.data.duplicate === true);
  const st = await c.request('collector:status', { sessionId, collecting: true, locationSampleCount: 4, motionSampleCount: 2, pendingBatchCount: 0 });
  check('collector:status ACK', st.ok);

  // ---- invalid messages ----
  const badPayload = await c.request('telemetry:batch', { ...batch, batchId: 'not-a-uuid', locations: [{ sequence: -1 }] });
  check('invalid payload → ok:false retryable:false', !badPayload.ok && badPayload.error.code === 'VALIDATION_ERROR' && badPayload.error.retryable === false && badPayload.error.status === 400);
  const unknown = await c.request('nope:event', {});
  check('unknown type → UNKNOWN_TYPE', !unknown.ok && unknown.error.code === 'UNKNOWN_TYPE');
  ws2!.send('this is not json');
  ws2!.send(JSON.stringify({ type: 'session:start', payload: {} }));
  await new Promise((r) => setTimeout(r, 300));
  check('non-JSON / missing requestId → error ACK with requestId null', c.stray.length === 2 && c.stray.every((a) => !a.ok && a.requestId === null), c.stray.map((a) => a.error?.code));

  const fin = await c.request('session:finish', { sessionId, clientSessionId, endedAt: new Date().toISOString() });
  const finAgain = await c.request('session:finish', { sessionId, clientSessionId, endedAt: new Date().toISOString() });
  check('session:finish ACK + idempotent retry', fin.ok && fin.data.status === 'FINISHED' && finAgain.ok);

  const locs = (await (await fetch(`${args.server}/api/v1/sessions/${sessionId}/locations`)).json()) as { sequence: number }[];
  check('DB has each location exactly once', JSON.stringify(locs.map((l) => l.sequence)) === '[1,2,3,4]', locs.map((l) => l.sequence));
  ws2!.close(1000, 'check done');

  console.log(`\n${failures === 0 ? 'ALL PASSED' : `${failures} FAILED`}  (sessionId ${sessionId}, device ${deviceId})`);
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
