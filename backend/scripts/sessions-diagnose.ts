/**
 * Read-only synchronization diagnosis of collection sessions (local-first / delayed upload).
 *
 *   npm run sessions:diagnose -- --session=<uuid>
 *   npm run sessions:diagnose -- --all
 */
import { parseArgs } from 'node:util';
import { pool } from '../src/config/database.js';
import { sessionService } from '../src/modules/sessions/session.service.js';
import { fusionRepository } from '../src/modules/fusion/fusion.repository.js';

const { values: args } = parseArgs({ options: { session: { type: 'string' }, all: { type: 'boolean', default: false } } });

const t = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString().replace('T', ' ').slice(0, 19) : '–');
const dur = (s: number | null | undefined) => (s == null ? '–' : s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`);

async function outOfOrderSamples(sessionId: string): Promise<number> {
  // samples whose sensor time is older than something already received before them (arrival order != sensor order)
  const { rows } = await pool.query<{ n: number }>(
    `SELECT count(*) AS n FROM (
       SELECT "timestamp", max("timestamp") OVER (ORDER BY created_at, id ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) AS prev_max
         FROM motion_samples WHERE session_id = $1) x
      WHERE "timestamp" < prev_max - interval '15 seconds'`,
    [sessionId],
  );
  return rows[0].n;
}

async function diagnose(id: string) {
  const v = await sessionService.detail(id);
  const raw = v.raw as {
    streams: { stream: string; count: number; live: number; recovered: number; firstCapturedAt: Date; lastCapturedAt: Date; firstReceivedAt: Date; lastReceivedAt: Date; maxReceiveDelaySeconds: number; segments: number }[];
    motionGapsOver1s: number;
    maxMotionGapMs: number | null;
    batches: number;
    outOfOrderBatches: number;
    diagnosticEvents: number;
    diagnostics: Record<string, unknown> | null;
    syncManifest: { synchronized?: boolean } | null;
  };
  const by = Object.fromEntries(raw.streams.map((s) => [s.stream, s]));
  const capFirst = raw.streams.map((s) => new Date(s.firstCapturedAt).getTime());
  const capLast = raw.streams.map((s) => new Date(s.lastCapturedAt).getTime());
  const rcvFirst = raw.streams.map((s) => new Date(s.firstReceivedAt).getTime());
  const rcvLast = raw.streams.map((s) => new Date(s.lastReceivedAt).getTime());
  const maxDelay = Math.max(0, ...raw.streams.map((s) => s.maxReceiveDelaySeconds ?? 0));
  const runs = await fusionRepository.latestRuns(id);

  console.log(`\n=== Session ${v.sessionId} (${v.collectorId})`);
  console.log(`Collection:      ${v.collectionState}${v.interrupted ? ' (sensor continuity INTERRUPTED)' : ''}   Sync: ${v.syncState}   started ${t(v.startedAt)}  ended ${t(v.endedAt)}  (row created ${t(v.createdAt)})`);
  console.log(`Raw time range:  ${capFirst.length ? `${t(new Date(Math.min(...capFirst)))} → ${t(new Date(Math.max(...capLast)))}` : '–'}`);
  console.log(`Receive range:   ${rcvFirst.length ? `${t(new Date(Math.min(...rcvFirst)))} → ${t(new Date(Math.max(...rcvLast)))}` : '–'}`);
  console.log(`Max upload delay: ${dur(maxDelay)}   batches ${raw.batches} (out-of-order ${raw.outOfOrderBatches})   out-of-order motion samples ${await outOfOrderSamples(id)}`);
  for (const k of ['location', 'motion', 'altimeter', 'pedometer']) {
    const s = by[k];
    console.log(`${(k[0].toUpperCase() + k.slice(1) + ':').padEnd(11)} ${s ? `${String(s.count).padStart(7)} samples (live ${s.live}, recovered ${s.recovered}, segments ${s.segments})` : '      0 samples'}`);
  }
  console.log(`Motion gaps > 1s: ${raw.motionGapsOver1s}   max motion gap ${raw.maxMotionGapMs ?? '–'} ms   diagnostic events ${raw.diagnosticEvents}`);
  if (raw.syncManifest) console.log(`Sync manifest:   ${raw.syncManifest.synchronized ? 'all streams synchronized' : 'NOT synchronized'} ${JSON.stringify(raw.syncManifest)}`);
  if (raw.diagnostics) console.log(`Client diagnostics: ${JSON.stringify(raw.diagnostics)}`);
  console.log(`Fusion ${v.fusion.version}: ${v.fusion.state}${v.fusion.needsReprocess ? ' (needs reprocess)' : ''}   runs: ${runs.map((r) => `${r.algorithmVersion} ${r.status}`).join(', ') || '–'}`);
}

async function main() {
  const sessions = await fusionRepository.listSessions();
  const ids = args.all ? sessions.map((s) => s.id) : sessions.filter((s) => s.id === args.session).map((s) => s.id);
  if (!ids.length) throw new Error(args.session ? `Session ${args.session} not found` : 'Pass --session=<uuid> or --all');
  for (const id of ids) await diagnose(id);
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());

