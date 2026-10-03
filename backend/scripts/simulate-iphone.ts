/**
 * Fake iPhone collector for testing the server + preview without a phone.
 *
 *   npm run sim -- --collector C02 --seconds 120                 # server defaults to this Mac on PORT from .env
 *   npm run sim -- --server http://100.102.255.108:3000         # any other address
 *   npm run sim -- --lat 37.5665 --lon 126.9780            # walk around another place
 *
 * It follows the real iOS contract: REST login → /collector socket → session:start →
 * telemetry:batch every 2 s (1 Hz location, 20 Hz motion, altimeter, pedometer) → marker:create
 * every 15 s → collector:status every 5 s → session:finish. Each 5th batch is sent twice to
 * exercise batchId idempotency.
 */
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { io } from 'socket.io-client';
import { env } from '../src/config/env.js';

const { values: args } = parseArgs({
  options: {
    server: { type: 'string', default: `http://127.0.0.1:${env.PORT}` },
    collector: { type: 'string', default: 'C01' },
    seconds: { type: 'string', default: '90' },
    lat: { type: 'string', default: '37.5665' },
    lon: { type: 'string', default: '126.9780' },
  },
});

const SERVER = args.server!;
const deviceId = `SIM-${args.collector}-${randomUUID().slice(0, 8).toUpperCase()}`;
const center = { lat: Number(args.lat), lon: Number(args.lon) };
const GEOID_UNDULATION = 23.5; // ≈ ellipsoid - MSL in Korea

async function emitWithAck<T = any>(socket: ReturnType<typeof io>, event: string, payload: unknown): Promise<T> {
  return socket.timeout(10_000).emitWithAck(event, payload);
}

async function main() {
  // 1. REST login
  const loginRes = await fetch(`${SERVER}/api/v1/collectors/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ collectorId: args.collector, deviceId, platform: 'ios', deviceModel: 'Simulator', systemVersion: '18.0', appVersion: 'sim' }),
  });
  const login = (await loginRes.json()) as { collectorId: string; accessToken: string };
  if (!loginRes.ok) throw new Error(`login failed: ${JSON.stringify(login)}`);
  console.log('login ok', login.collectorId);

  // 2. Socket.IO /collector
  const socket = io(`${SERVER}/collector`, { auth: { token: login.accessToken, deviceId }, transports: ['websocket'] });
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('connect_error', (e: any) => reject(new Error(`connect_error ${e.message} ${JSON.stringify(e.data)}`)));
  });
  console.log('socket connected', socket.id);

  // 3. session:start
  const clientSessionId = randomUUID();
  const start = await emitWithAck(socket, 'session:start', {
    clientSessionId, deviceId, platform: 'ios', deviceModel: 'Simulator', systemVersion: '18.0', appVersion: 'sim',
    sensorCapabilities: { location: true, motion: true, altimeter: true, pedometer: true },
  });
  console.log('session:start', start);
  if (!start.ok) throw new Error('session:start failed');
  const sessionId: string = start.sessionId;

  // 4. collect + send
  let locSeq = 0, motionSeq = 0, altSeq = 0, steps = 0, batchNo = 0, markerNo = 0;
  const startMs = Date.now();
  const endMs = startMs + Number(args.seconds) * 1000;
  const radius = 0.0012; // ~130 m loop
  const phase = Math.random() * Math.PI * 2;

  const sendBatch = async () => {
    const now = Date.now();
    const locations = [], motion = [], altimeter = [];
    for (let i = 0; i < 2; i++) {
      const t = now - (1 - i) * 1000;
      const a = phase + ((t - startMs) / 1000) * 0.03;
      const alt = 40 + 6 * Math.sin(a * 2);
      // Direction of travel on the loop (d/da of the position), as compass degrees: atan2(east, north)
      const course = ((Math.atan2(-radius * 1.25 * Math.sin(a) * Math.cos((center.lat * Math.PI) / 180), radius * Math.cos(a)) * 180) / Math.PI + 360) % 360;
      locations.push({
        sequence: ++locSeq, timestamp: new Date(t).toISOString(),
        latitude: center.lat + radius * Math.sin(a), longitude: center.lon + radius * 1.25 * Math.cos(a),
        altitude: alt, ellipsoidalAltitude: alt + GEOID_UNDULATION,
        horizontalAccuracy: 3 + Math.random() * 8, verticalAccuracy: 4 + Math.random() * 6,
        speed: 1.3, speedAccuracy: 0.5, course, courseAccuracy: 10,
      });
      altimeter.push({ sequence: ++altSeq, timestamp: new Date(t).toISOString(), relativeAltitude: alt - 40, pressure: 101.3 - alt * 0.012 });
    }
    for (let i = 0; i < 40; i++) {
      const t = now - 2000 + i * 50;
      const r = () => (Math.random() - 0.5) * 0.2;
      const step = () => (Math.random() - 0.5) * 0.9; // walking-like userAcceleration (g), RMS ≈ 0.26 g
      motion.push({
        sequence: ++motionSeq, timestamp: new Date(t).toISOString(),
        userAcceleration: { x: step(), y: step(), z: step() }, rotationRate: { x: r(), y: r(), z: r() },
        gravity: { x: 0, y: -0.98, z: -0.1 }, attitude: { roll: r(), pitch: r(), yaw: r() },
      });
    }
    steps += 4;
    const batch = {
      batchId: randomUUID(), sessionId, clientSessionId, createdAt: new Date().toISOString(),
      locations, motion, altimeter,
      pedometer: [{ timestamp: new Date(now).toISOString(), numberOfSteps: steps, distance: steps * 0.7, currentPace: 0.6, currentCadence: 2, floorsAscended: 0, floorsDescended: 0 }],
    };
    batchNo++;
    const ack = await emitWithAck(socket, 'telemetry:batch', batch);
    console.log(`batch #${batchNo}`, ack.ok ? `ok duplicate=${ack.duplicate}` : JSON.stringify(ack.error));
    if (batchNo % 5 === 0) {
      const again = await emitWithAck(socket, 'telemetry:batch', batch);
      console.log(`batch #${batchNo} resent`, again.ok ? `ok duplicate=${again.duplicate}` : JSON.stringify(again.error));
    }
    if (batchNo % 7 === 0) {
      const last = locations[locations.length - 1];
      const types = ['entrance', 'intersection', 'stairStart', 'stairEnd', 'elevator', 'stop', 'custom'];
      const marker = await emitWithAck(socket, 'marker:create', {
        markerId: randomUUID(), sessionId, clientSessionId, timestamp: last.timestamp,
        type: types[markerNo++ % types.length], note: `sim marker ${markerNo}`,
        latitude: last.latitude, longitude: last.longitude, altitude: last.altitude, ellipsoidalAltitude: last.ellipsoidalAltitude,
        horizontalAccuracy: last.horizontalAccuracy, verticalAccuracy: last.verticalAccuracy,
      });
      console.log('marker:create', marker);
    }
    if (batchNo % 3 === 0) {
      await emitWithAck(socket, 'collector:status', {
        sessionId, collecting: true, locationSampleCount: locSeq, motionSampleCount: motionSeq, pendingBatchCount: 0,
      });
    }
  };

  while (Date.now() < endMs) {
    await sendBatch();
    await new Promise((r) => setTimeout(r, 2000));
  }

  // 5. session:finish (sent twice: must be idempotent)
  const finishPayload = { sessionId, clientSessionId, endedAt: new Date().toISOString() };
  console.log('session:finish', await emitWithAck(socket, 'session:finish', finishPayload));
  console.log('session:finish again', await emitWithAck(socket, 'session:finish', finishPayload));
  socket.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
