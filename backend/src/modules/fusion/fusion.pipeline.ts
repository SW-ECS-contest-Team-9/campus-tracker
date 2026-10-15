// Shared fusion pipeline (docs/MOBILITY_MAP_PLAN.md 4.3): the ONE place where observations go through an
// algorithm. Realtime (fusion.service applyLive), authoritative replays and experiment replays all use it, so
// no mode carries its own correction logic.
import { sessionRepository } from '../sessions/session.repository.js';
import { spatial } from '../../geo/spatial.js';
import { terrain, type TerrainContext } from '../../geo/terrain.js';
import { buildTimeline, compareObservations, type Observation, type RawSamples } from './fusion.timeline.js';
import type { FusionAlgorithm } from './fusion.algorithms.js';
import type { FusionSessionContext } from './fusion.stride.js';
import type { FusedOutput } from './fusion.types.js';
import { fusionRepository } from './fusion.repository.js';
import { fusionRunsRepository } from './fusion-runs.repository.js';
import { pool } from '../../config/database.js';
import { env } from '../../config/env.js';
import { cutRawSamples, summarizeReplayInput, type ReplayInputSummary } from './fusion.replay-input.js';

export interface StepOutput { outputs: FusedOutput[]; events: unknown[] }

/** Feeds observations (already in processing order) through the algorithm. */
export function runObservations(algo: FusionAlgorithm, state: unknown, observations: Observation[]): StepOutput {
  const outputs: FusedOutput[] = [];
  const events: unknown[] = [];
  for (const o of observations) {
    // optional streams only fusion-v4 understands (older engines would read them as GPS)
    if ((o.kind === 'absoluteAltitude' || o.kind === 'beacon') && algo.version !== 'fusion-v4') continue;
    const r = algo.process(state, o);
    outputs.push(...r.outputs);
    events.push(...r.events);
  }
  return { outputs, events };
}

/** Attaches the session terrain to every observation (a shared reference, like the spatial context). */
export function withTerrain(observations: Observation[], context: TerrainContext | null): Observation[] {
  if (!context) return observations;
  return observations.map((o) => ({ ...o, terrainContext: context }));
}

/**
 * Realtime reorder buffer: observations wait `windowMs` (sensor time behind the newest seen) so slightly late
 * samples (GPS vs 50 Hz motion) are still applied in order.
 */
export class ReorderBuffer {
  buffer: Observation[] = [];
  maxSeenT = -Infinity;
  constructor(readonly windowMs: number) {}

  /** Adds a batch (sorted or not) and returns the observations that are now old enough, in order. */
  push(incoming: Observation[]): Observation[] {
    if (incoming.length === 0) return [];
    this.buffer.push(...incoming);
    this.buffer.sort(compareObservations);
    // Auxiliary height reports must not release primary sensors early or alter their output schedule.
    // ...nor beacons, which arrive in their own messages, often ahead of the telemetry batch with the motion samples
    for (const o of incoming) if (o.kind !== 'absoluteAltitude' && o.kind !== 'beacon') this.maxSeenT = Math.max(this.maxSeenT, o.t);
    const releaseUntil = this.maxSeenT - this.windowMs;
    let n = 0;
    while (n < this.buffer.length && this.buffer[n].t <= releaseUntil) n++;
    return this.buffer.splice(0, n);
  }

  drain(): Observation[] {
    return this.buffer.splice(0);
  }
}

export interface ReplayResult {
  state: unknown;
  /** outputs of the forward (realtime-equivalent) pass, flushed unless the session continues live */
  forward: FusedOutput[];
  /** stored result: finalize() outputs when the algorithm has a finalize step, else the forward outputs */
  outputs: FusedOutput[];
  events: unknown[];
}

/** Authoritative replay of a sensor-time-ordered timeline. finalize false (continuesLive): no flush / smoother (realtime goes on). */
export function replayInMemory(algo: FusionAlgorithm, timeline: Observation[], opts: { finalize: boolean; smooth?: boolean; state?: unknown; context?: FusionSessionContext }): ReplayResult {
  const state = opts.state ?? algo.createState(opts.context);
  const r = runObservations(algo, state, timeline);
  const forward = r.outputs;
  const events = r.events;
  if (!opts.finalize) return { state, forward, outputs: forward, events };
  const f = algo.flush(state);
  forward.push(...f.outputs);
  events.push(...f.events);
  // smooth: false = the complete forward pass only (experiments comparing it with the smoothed result)
  if (!algo.finalize || opts.smooth === false) return { state, forward, outputs: forward, events };
  // e.g. fusion-v4: the smoothed trajectory replaces the forward (realtime-equivalent) outputs
  const fin = algo.finalize(state);
  events.push(...fin.events);
  return { state, forward, outputs: fin.outputs, events };
}

/**
 * AS_RECEIVED replay: the raw samples regrouped into the batches the server committed (one transaction =
 * one created_at) and fed in arrival order through the realtime reorder buffer, then the live finish (flush).
 * Reproduces what the realtime result looked like, including samples dropped because they arrived too late.
 */
export function replayAsReceived(algo: FusionAlgorithm, batches: Observation[][], windowMs: number, context?: FusionSessionContext): ReplayResult & { skippedLate: number } {
  const state = algo.createState(context);
  const buffer = new ReorderBuffer(windowMs);
  const forward: FusedOutput[] = [];
  const events: unknown[] = [];
  for (const batch of batches) {
    const r = runObservations(algo, state, buffer.push(batch.filter((o) => !(o.kind === 'gps' && o.preSession))));
    forward.push(...r.outputs);
    events.push(...r.events);
  }
  const r = runObservations(algo, state, buffer.drain());
  forward.push(...r.outputs);
  events.push(...r.events);
  const f = algo.flush(state);
  forward.push(...f.outputs);
  events.push(...f.events);
  return { state, forward, outputs: forward, events, skippedLate: algo.skippedLate(state) };
}

export interface ReplayInputs {
  session: NonNullable<Awaited<ReturnType<typeof sessionRepository.findView>>>;
  raw: RawSamples & { receivedAt?: Record<string, (string | null)[]> };
  timeline: Observation[];
  mapVersionId: string | null;
  terrainVersionId: string | null;
  terrainContext: TerrainContext | null;
  /** identity of the run's input: cutoff, row counts and a hash of what fusion reads */
  input: ReplayInputSummary;
  /** AS_RECEIVED only: the same rows regrouped into the batches the server committed, in arrival order */
  arrival?: { batches: Observation[][]; outOfOrderBatches: number };
}

export interface ReplayInputOptions {
  /** sensor-time upper bound (inclusive); rows captured later are not part of this run */
  cutoff?: Date | null;
  /** also load the arrival batches (AS_RECEIVED) from the SAME database snapshot */
  arrival?: boolean;
}

/**
 * Everything a replay of one session needs: raw samples (read-only), the pinned map and terrain.
 * All raw rows of the run come from ONE repeatable-read snapshot, so a batch committed while the run loads its
 * input is either entirely in the run or not at all (the four streams and the arrival batches always agree).
 */
export async function loadReplayInputs(sessionId: string, algo: FusionAlgorithm, opts: ReplayInputOptions = {}): Promise<ReplayInputs> {
  const session = await sessionRepository.findView(sessionId);
  if (!session) throw new Error(`Session ${sessionId} not found`);
  const mapVersionId = session.spatialMapVersionId;
  const spatialContext = await spatial.context(mapVersionId);
  const terrainVersionId = algo.usesTerrain ? await terrain.sessionVersion(sessionId) : null;
  const terrainContext = await terrain.context(terrainVersionId);
  const cutoff = opts.cutoff ? opts.cutoff.getTime() : null;
  // one query at a time on this connection (the repository loaders run their four SELECTs in parallel on a pool)
  const client = await pool.connect();
  const serial: Pick<typeof client, 'query'> = { query: ((...a: Parameters<typeof client.query>) => (chain = chain.then(() => client.query(...a), () => client.query(...a)))) as typeof client.query };
  let chain: Promise<unknown> = Promise.resolve();
  let all: RawSamples;
  let arrivalRaw: RawSamples[] | null = null;
  try {
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    all = await fusionRepository.loadRawSamples(sessionId, serial as typeof client);
    if (opts.arrival) arrivalRaw = await fusionRunsRepository.loadArrivalBatches(sessionId, serial as typeof client);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
  const raw = cutRawSamples(all, cutoff);
  const annotate = (samples: RawSamples) =>
    withTerrain(spatial.annotate(buildTimeline(samples, { sessionStartedAt: session.startedAt }), spatialContext), terrainContext);
  const timeline = annotate(raw);
  const inputs: ReplayInputs = { session, raw, timeline, mapVersionId, terrainVersionId, terrainContext, input: summarizeReplayInput(raw, cutoff) };
  if (arrivalRaw) {
    const batches = arrivalRaw.map((b) => annotate(cutRawSamples(b, cutoff))).filter((b) => b.length > 0);
    inputs.arrival = { batches, outOfOrderBatches: countOutOfOrderBatches(batches, env.FUSION_REORDER_WINDOW_MS) };
  }
  return inputs;
}

/**
 * Batches whose oldest observation is more than `windowMs` older than something an earlier batch already delivered
 * (sensor time): the realtime reorder buffer cannot put those back in order.
 */
export function countOutOfOrderBatches(batches: Observation[][], windowMs = 0): number {
  let seen = -Infinity;
  let n = 0;
  for (const b of batches) {
    const session = b.filter((o) => !(o.kind === 'gps' && o.preSession));
    if (!session.length) continue;
    if (session[0].t < seen - windowMs) n++;
    seen = Math.max(seen, session.at(-1)!.t);
  }
  return n;
}
