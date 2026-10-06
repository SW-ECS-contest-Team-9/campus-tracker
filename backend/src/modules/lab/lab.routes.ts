// Lab API (docs/MOBILITY_MAP_PLAN.md 4.11–4.12): replays into run snapshots, run data, qc-v1, routes, canonical
// paths, validation and bench results. Same scope as the other Preview APIs (internal development tool).
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { Uuid } from '../../common/dto.js';
import { AppError } from '../../common/errors/app-error.js';
import { FUSION_ALGORITHMS } from '../fusion/fusion.algorithms.js';
import { replaySession } from '../fusion/fusion.service.js';
import { fusionRunsRepository } from '../fusion/fusion-runs.repository.js';
import { qcService } from '../qc/qc.service.js';
import { pathfusionService, benchResult, listBench, trackPoints } from '../pathfusion/pathfusion.service.js';
import { resampleTrack } from '../trajectory/resample.js';

export const labRoutes = Router();

const IdParam = z.object({ id: Uuid });
const SessionParam = z.object({ sessionId: Uuid });
const Point = z.union([z.object({ x: z.number(), y: z.number() }), z.object({ latitude: z.number().min(-90).max(90), longitude: z.number().min(-180).max(180) })]);

const ReplayBody = z.object({
  algorithmVersion: z.string().refine((v) => v in FUSION_ALGORITHMS, 'unknown algorithm version'),
  variant: z.string().trim().min(1).max(48).nullish(),
  overrides: z.record(z.string(), z.union([z.number(), z.boolean(), z.string()])).nullish(),
  mode: z.enum(['SENSOR_TIME', 'AS_RECEIVED']).default('SENSOR_TIME'),
  publish: z.boolean().default(false),
});

async function run(req: Request) {
  const { id } = IdParam.parse(req.params);
  const r = await fusionRunsRepository.get(id);
  if (!r) throw AppError.notFound('RUN_NOT_FOUND', 'Run not found');
  return r;
}

// ---- runs ----
labRoutes.post('/sessions/:sessionId/replays', async (req: Request, res: Response) => {
  const { sessionId } = SessionParam.parse(req.params);
  const b = ReplayBody.parse(req.body ?? {});
  const r = await replaySession(sessionId, b.algorithmVersion, 'lab', { variant: b.variant ?? null, overrides: b.overrides ?? null, mode: b.mode, publish: b.publish });
  res.json({ runId: r.runId, outputs: r.outputs.length, durationMs: r.durationMs, published: r.published, metrics: r.metrics });
});
labRoutes.get('/sessions/:sessionId/runs', async (req: Request, res: Response) => {
  const { sessionId } = SessionParam.parse(req.params);
  res.json(await fusionRunsRepository.listBySession(sessionId));
});
labRoutes.get('/sessions/:sessionId/qc', async (req: Request, res: Response) => {
  const { sessionId } = SessionParam.parse(req.params);
  const list = await qcService.list(sessionId);
  if (!list.decisions.length) {
    await qcService.run(sessionId);
    res.json(await qcService.list(sessionId));
    return;
  }
  res.json(list);
});
labRoutes.get('/runs/:id', async (req, res) => res.json(await run(req)));
labRoutes.get('/runs/:id/positions', async (req, res) => {
  const r = await run(req);
  const stage = z.object({ stage: z.enum(['FORWARD', 'FINAL']).default('FINAL') }).parse(req.query).stage;
  res.json(await fusionRunsRepository.positions(r.id, stage));
});
labRoutes.get('/runs/:id/fixes', async (req, res) => res.json(await fusionRunsRepository.fixes((await run(req)).id)));
labRoutes.get('/runs/:id/events', async (req, res) => res.json(await fusionRunsRepository.events((await run(req)).id)));
labRoutes.get('/runs/:id/resampled', async (req, res) => {
  const r = await run(req);
  const { ds } = z.object({ ds: z.coerce.number().min(0.25).max(10).default(1) }).parse(req.query);
  const { points, hRelative } = trackPoints(await fusionRunsRepository.positions(r.id, 'FINAL'));
  res.json({ hRelative, ...resampleTrack(points, { ds }) });
});
labRoutes.post('/runs/:id/pin', async (req, res) => {
  const r = await run(req);
  const { pinned } = z.object({ pinned: z.boolean() }).parse(req.body ?? {});
  await fusionRunsRepository.setFlags(r.id, { pinned });
  res.json({ runId: r.id, pinned });
});

// ---- routes / passes / canonical / validation ----
labRoutes.get('/routes', async (_req, res) => res.json(await pathfusionService.listRoutes()));
labRoutes.post('/routes', async (req, res) => {
  const b = z.object({
    name: z.string().trim().min(1).max(80), a: Point, b: Point,
    radiusM: z.number().min(2).max(60).optional(), widthM: z.number().min(2).max(100).optional(),
    fusionVersion: z.string().refine((v) => v in FUSION_ALGORITHMS).optional(), fusionVariant: z.string().max(48).nullish(), notes: z.string().max(500).nullish(),
  }).parse(req.body ?? {});
  res.json(await pathfusionService.createRoute(b));
});
labRoutes.get('/routes/:id', async (req, res) => {
  const { id } = IdParam.parse(req.params);
  const [route, passes, reports] = await Promise.all([pathfusionService.getRoute(id), pathfusionService.passes(id), pathfusionService.latestReports(id)]);
  const latest = (await pathfusionService.listRoutes()).find((r) => r.id === id)?.canonicalPathId ?? null;
  res.json({ ...route, passes, canonicalPathId: latest, reports });
});
labRoutes.delete('/routes/:id', async (req, res) => {
  const { id } = IdParam.parse(req.params);
  await pathfusionService.deleteRoute(id);
  res.json({ deleted: id });
});
labRoutes.post('/routes/:id/passes/detect', async (req, res) => {
  const { id } = IdParam.parse(req.params);
  const b = z.object({ sessionIds: z.array(Uuid).max(500).optional(), includeSynthetic: z.boolean().optional() }).parse(req.body ?? {});
  res.json(await pathfusionService.detectPasses(id, b));
});
labRoutes.post('/routes/:id/passes', async (req, res) => {
  const { id } = IdParam.parse(req.params);
  const b = z.object({ sessionId: Uuid, tStart: z.iso.datetime({ offset: true }), tEnd: z.iso.datetime({ offset: true }), direction: z.enum(['AB', 'BA']).optional() }).parse(req.body ?? {});
  res.json(await pathfusionService.addManualPass(id, { sessionId: b.sessionId, tStart: Date.parse(b.tStart), tEnd: Date.parse(b.tEnd), direction: b.direction }));
});
labRoutes.post('/routes/:id/passes/:passId/exclude', async (req, res) => {
  const { id, passId } = z.object({ id: Uuid, passId: Uuid }).parse(req.params);
  const { excluded } = z.object({ excluded: z.boolean() }).parse(req.body ?? {});
  await pathfusionService.setPassExcluded(id, passId, excluded);
  res.json({ passId, excluded });
});
labRoutes.post('/routes/:id/canonical', async (req, res) => {
  const { id } = IdParam.parse(req.params);
  res.json(await pathfusionService.buildCanonical(id));
});
labRoutes.post('/routes/:id/validate', async (req, res) => {
  const { id } = IdParam.parse(req.params);
  res.json(await pathfusionService.validate(id));
});
labRoutes.get('/canonical-paths/:id', async (req, res) => res.json(await pathfusionService.canonicalPath(IdParam.parse(req.params).id)));
labRoutes.get('/validation-reports/:id', async (req, res) => res.json(await pathfusionService.validationReport(IdParam.parse(req.params).id)));
labRoutes.get('/bench-results', async (_req, res) => res.json(await listBench()));
labRoutes.get('/bench-results/:id', async (req, res) => res.json(await benchResult(IdParam.parse(req.params).id)));
