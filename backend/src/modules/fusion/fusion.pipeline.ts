// Shared fusion pipeline (docs/MOBILITY_MAP_PLAN.md 4.3): the ONE place where observations go through an
// algorithm. Realtime (fusion.service applyLive), authoritative replays and experiment replays all use it, so
// no mode carries its own correction logic.
import { sessionRepository } from '../sessions/session.repository.js';
import { spatial } from '../../geo/spatial.js';
import { terrain, type TerrainContext } from '../../geo/terrain.js';
import { buildTimeline, compareObservations, type Observation, type RawSamples } from './fusion.timeline.js';
import type { FusionAlgorithm } from './fusion.algorithms.js';
import type { FusedOutput } from './fusion.types.js';
import { fusionRepository } from './fusion.repository.js';

export interface StepOutput { outputs: FusedOutput[]; events: unknown[] }

/** Feeds observations (already in processing order) through the algorithm. */
export function runObservations(algo: FusionAlgorithm, state: unknown, observations: Observation[]): StepOutput {
  const outputs: FusedOutput[] = [];
  const events: unknown[] = [];
  for (const o of observations) {
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
    for (const o of incoming) this.maxSeenT = Math.max(this.maxSeenT, o.t);
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

/** Authoritative replay of a sensor-time-ordered timeline. continuesLive: no flush / finalize (realtime goes on). */
export function replayInMemory(algo: FusionAlgorithm, timeline: Observation[], opts: { finalize: boolean; state?: unknown }): ReplayResult {
  const state = opts.state ?? algo.createState();
  const r = runObservations(algo, state, timeline);
  const forward = r.outputs;
  const events = r.events;
  if (!opts.finalize) return { state, forward, outputs: forward, events };
  const f = algo.flush(state);
  forward.push(...f.outputs);
  events.push(...f.events);
  if (!algo.finalize) return { state, forward, outputs: forward, events };
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
export function replayAsReceived(algo: FusionAlgorithm, batches: Observation[][], windowMs: number): ReplayResult & { skippedLate: number } {
  const state = algo.createState();
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
}

/** Everything a replay of one session needs: raw samples (read-only), the pinned map and terrain. */
export async function loadReplayInputs(sessionId: string, algo: FusionAlgorithm): Promise<ReplayInputs> {
  const session = await sessionRepository.findView(sessionId);
  if (!session) throw new Error(`Session ${sessionId} not found`);
  const mapVersionId = session.spatialMapVersionId;
  const spatialContext = await spatial.context(mapVersionId);
  const terrainVersionId = algo.usesTerrain ? await terrain.sessionVersion(sessionId) : null;
  const terrainContext = await terrain.context(terrainVersionId);
  const raw = await fusionRepository.loadRawSamples(sessionId);
  const timeline = withTerrain(spatial.annotate(buildTimeline(raw, { sessionStartedAt: session.startedAt }), spatialContext), terrainContext);
  return { session, raw, timeline, mapVersionId, terrainVersionId, terrainContext };
}
