// Synthetic walk as RAW rows (what the sample tables hold), shared by the pipeline and integration tests.
import type { RawSamples } from '../../src/modules/fusion/fusion.timeline.js';
import { localToWgs84 } from '../../src/geo/local-to-wgs84.js';

const ORIGIN = { latitude: 37.6158, longitude: 127.0118, height: 0 };
export const T0 = Date.parse('2026-10-13T12:54:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();

export function rng(seed: number) {
  let s = seed >>> 0;
  const u = () => ((s = (1664525 * s + 1013904223) >>> 0) + 0.5) / 2 ** 32;
  return { u, n: () => Math.sqrt(-2 * Math.log(u())) * Math.cos(2 * Math.PI * u()) };
}

/** An L-shaped walk as RAW rows (what the tables hold): 50 Hz motion, 1 Hz barometer, pedometer every 2.5 s, GPS every 2 s. */
export function walk(seconds: number): RawSamples {
  const r = rng(5);
  const raw: RawSamples = { locations: [], motion: [], altimeter: [], pedometer: [] };
  let x = 0, y = 0, steps = 0, lastStep = -1;
  for (let k = 0; k < seconds * 50; k++) {
    const t = k / 50;
    const heading = t < seconds / 2 ? 0 : Math.PI / 2;
    const timestamp = iso(T0 + k * 20);
    raw.motion.push({ sequence: k, timestamp, yaw: -(heading - 1), ax: 0.005 * r.n(), ay: 0.005 * r.n(), az: 0.2 * Math.sin(4 * Math.PI * t) + 0.01 * r.n(), gx: 0, gy: 0, gz: -1, segment: 'A' });
    if (Math.floor(t * 2) !== lastStep) {
      lastStep = Math.floor(t * 2);
      x += 0.75 * Math.sin(heading);
      y += 0.75 * Math.cos(heading);
      steps++;
    }
    if (k % 125 === 0) raw.pedometer.push({ timestamp, numberOfSteps: steps, distance: steps * 0.75, segment: 'A' });
    if (k % 50 === 25) raw.altimeter.push({ sequence: k, timestamp, relativeAltitude: 0, segment: 'A' });
    if (k % 100 === 60) {
      const p = localToWgs84(ORIGIN, { x: x + 6 * r.n(), y: y + 6 * r.n(), z: 0 });
      raw.locations.push({ sequence: k, timestamp, latitude: p.latitude, longitude: p.longitude, altitude: 60, ellipsoidalAltitude: 90, horizontalAccuracy: 10, verticalAccuracy: 8, speed: -1, course: -1 });
    }
  }
  return raw;
}

export function shuffled(raw: RawSamples, seed: number): RawSamples {
  const r = rng(seed);
  const mix = <T>(rows: T[]) => rows.map((v) => ({ v, k: r.u() })).sort((a, b) => a.k - b.k).map((e) => e.v);
  return { locations: mix(raw.locations), motion: mix(raw.motion), altimeter: mix(raw.altimeter), pedometer: mix(raw.pedometer) };
}

/** The rows of [from, to) seconds as one upload batch. */
export function batch(raw: RawSamples, from: number, to: number): RawSamples {
  const inside = <T extends { timestamp: string | Date }>(rows: T[]) => rows.filter((s) => {
    const t = (Date.parse(s.timestamp as string) - T0) / 1000;
    return t >= from && t < to;
  });
  return { locations: inside(raw.locations), motion: inside(raw.motion), altimeter: inside(raw.altimeter), pedometer: inside(raw.pedometer) };
}

