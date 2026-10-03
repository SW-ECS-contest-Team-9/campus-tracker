/**
 * Read-only diagnosis of stored data: raw sensor ranges vs. every stored fusion version of a session.
 *
 *   npm run fusion:diagnose -- --session=<uuid>
 *   npm run fusion:diagnose -- --all
 *
 * Uses the same sanity validation as the reprocessing runs (fusion.validation.ts). Nothing is written.
 */
import { parseArgs } from 'node:util';
import { pool } from '../src/config/database.js';
import { fusionRepository } from '../src/modules/fusion/fusion.repository.js';
import { buildTimeline } from '../src/modules/fusion/fusion.timeline.js';
import { validateFusion } from '../src/modules/fusion/fusion.validation.js';
import { checkPedometerCounter, createPedometerCounter, restartPedometerCounter } from '../src/modules/fusion/fusion.pedometer.js';

const { values: args } = parseArgs({ options: { session: { type: 'string' }, all: { type: 'boolean', default: false } } });

const r1 = (v: number | null | undefined) => (v === null || v === undefined ? '–' : (Math.round(v * 10) / 10).toString());
const q = (v: number[], p: number) => {
  const s = [...v].sort((a, b) => a - b);
  return s.length ? s[Math.floor(p * (s.length - 1))] : null;
};
const R = 6371008.8;
const RAD = Math.PI / 180;

async function diagnose(sessionId: string, collectorId: string) {
  const timeline = buildTimeline(await fusionRepository.loadRawSamples(sessionId));
  const gps = timeline.filter((o): o is Extract<typeof o, { kind: 'gps' }> => o.kind === 'gps');
  const ped = timeline.filter((o): o is Extract<typeof o, { kind: 'pedometer' }> => o.kind === 'pedometer' && o.distance !== null);
  const alt = timeline.filter((o): o is Extract<typeof o, { kind: 'altimeter' }> => o.kind === 'altimeter' && o.relativeAltitude !== null);
  const acc = gps.map((g) => g.horizontalAccuracy).filter((a): a is number => a !== null && a > 0);
  const speeds = gps.map((g) => g.speed).filter((s): s is number => s !== null && s >= 0);
  const rel = alt.map((a) => a.relativeAltitude!);
  let rawDisp = 0;
  for (const g of gps) rawDisp = Math.max(rawDisp, Math.hypot((g.longitude - gps[0].longitude) * RAD * Math.cos(gps[0].latitude * RAD), (g.latitude - gps[0].latitude) * RAD) * R);
  const dur = timeline.length ? (timeline.at(-1)!.t - timeline[0].t) / 1000 : 0;

  console.log(`\n=== Session ${sessionId} (${collectorId})`);
  console.log(`Session duration: ${r1(dur)} s`);
  console.log(`Raw GPS: ${gps.length}  H accuracy median ${r1(q(acc, 0.5))} m  min ${r1(q(acc, 0))} m  max ${r1(q(acc, 1))} m  | speed median ${r1(q(speeds, 0.5))} m/s | max displacement ${r1(rawDisp)} m`);
  // cumulative per segment: count only increases above the running maximum (same rule as the engines)
  const counter = createPedometerCounter();
  let walked = 0;
  let ignored = 0;
  let restarts = 0;
  let segment: string | null | undefined;
  for (const p of ped) {
    if (segment === undefined || (p.segment ?? null) !== segment) {
      restartPedometerCounter(counter, p.steps, p.distance);
      segment = p.segment ?? null;
      continue;
    }
    const before = counter.maxDistance ?? p.distance!;
    const verdict = checkPedometerCounter(counter, p.steps, p.distance);
    if (verdict === 'OK') walked += p.distance! - before;
    else if (verdict === 'BELOW_HIGH_WATER') ignored++;
    else restarts++;
  }
  console.log(ped.length ? `Pedometer: ${ped.length} samples  walked ${r1(walked)} m  ignored below running max ${ignored}  counter restarts ${restarts}` : 'Pedometer: none');
  console.log(rel.length ? `Altimeter: min ${r1(Math.min(...rel))} m  max ${r1(Math.max(...rel))} m  range ${r1(Math.max(...rel) - Math.min(...rel))} m` : 'Altimeter: none');

  for (const { algorithmVersion } of await fusionRepository.versionsSummary(sessionId)) {
    const rows = await fusionRepository.list(sessionId, algorithmVersion);
    const v = validateFusion(timeline, rows.map((f) => ({ latitude: f.latitude, longitude: f.longitude, height: f.ellipsoidalAltitude ?? (f.localZ ?? null) })));
    const flag = v.warnings.length ? `  WARNING: ${v.warnings.map((w) => w.code).join(', ')}` : '';
    console.log(
      `${algorithmVersion.padEnd(12)} outputs ${String(rows.length).padStart(5)}  XY displacement ${r1(v.fusedMaxDisplacementM).padStart(7)} m (allowed ${r1(v.allowedDisplacementM)} m)  Z range ${r1(v.fusedZRangeM)} m${flag}`,
    );
    for (const w of v.warnings) console.log(`             - ${w.message}`);
  }
}

async function main() {
  const sessions = await fusionRepository.listSessions();
  const selected = args.all ? sessions : sessions.filter((s) => s.id === args.session);
  if (!selected.length) throw new Error(args.session ? `Session ${args.session} not found` : 'Pass --session=<uuid> or --all');
  for (const s of selected) await diagnose(s.id, s.collectorId);
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
