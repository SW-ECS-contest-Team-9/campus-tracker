import { Router } from 'express';
import { z } from 'zod';
import { Uuid } from '../../common/dto.js';
import { editorAuth } from './editor.auth.js';
import { areaRoutes } from './area.routes.js';
import { Anchor, BranchFrom, EditorQuery, JunctionSave, LeaseRelease, LeaseRequest, PlaceSave, RoadSave, RoadStyleSave, XYZ } from './editor.dto.js';
import { AppError } from '../../common/errors/app-error.js';
import { CAMPUS_FRAME } from '../../geo/campus-frame.js';
import { terrain } from '../../geo/terrain.js';
import { fusionRunsRepository } from '../fusion/fusion-runs.repository.js';
import { corridorCenterline } from '../editor-mcp/corridor.js';
import { terrainContext } from '../editor-mcp/terrain-access.js';
import { editorService } from './editor.service.js';
import { editorOps } from './editor.ops.js';
import type { CollectorIdentity } from '../../common/auth/jwt.js';
import { editorBroadcast } from '../../realtime/editor.gateway.js';

export const editorRoutes = Router();
editorRoutes.use(editorAuth);
editorRoutes.use(areaRoutes);
const identity = (res: import('express').Response) => res.locals.editorIdentity as CollectorIdentity;

editorRoutes.get('/snapshot', async (req, res) => {
  const { status } = EditorQuery.parse(req.query);
  res.json(await editorService.snapshot(status));
});
editorRoutes.get('/changes', async (req, res) => {
  const { limit } = z.object({ limit: z.coerce.number().int().min(1).max(100).default(20) }).parse(req.query);
  res.json(await editorService.recentChangeSets(limit));
});
editorRoutes.post('/changesets/:id/revert', async (req, res) => {
  const changeSetId = Uuid.parse(req.params.id);
  const body = z.object({ sessionId: Uuid, mutationId: Uuid }).parse(req.body);
  res.json(await editorOps.revertChangeSet({ changeSetId, ...body }, identity(res)));
});
editorRoutes.post('/leases', async (req, res) => {
  const lease = await editorService.acquireLease(LeaseRequest.parse(req.body), identity(res));
  const { leaseToken: _secret, sessionId: _session, ...publicLease } = lease;
  editorBroadcast.lease({ action: 'acquired', ...publicLease });
  res.status(201).json(lease);
});
editorRoutes.post('/leases/renew', async (req, res) => {
  const body = LeaseRequest.extend({ leaseToken: Uuid }).parse(req.body);
  const lease = await editorService.renewLease(body, body.leaseToken, identity(res));
  const { leaseToken: _secret, sessionId: _session, ...publicLease } = lease;
  editorBroadcast.lease({ action: 'renewed', ...publicLease });
  res.json(lease);
});
editorRoutes.post('/leases/release', async (req, res) => {
  const body = LeaseRelease.parse(req.body);
  const result = await editorService.releaseLease(body, identity(res));
  if (result.released) editorBroadcast.lease({ action: 'released', objectType: body.objectType, objectId: body.objectId, ownerCode: identity(res).collectorId });
  res.json(result);
});
editorRoutes.post('/topology-preview', async (req, res) => {
  const body = z.object({ coordinates: z.array(XYZ).min(2).max(20_000), levelId: z.string().max(80).nullish(), branchFrom: BranchFrom.optional(), anchors: z.array(Anchor).max(50).default([]),
    structure: z.string().max(40).nullish() }).parse(req.body);
  res.json(await editorService.previewTopology(body.coordinates, body.levelId ?? null, body.branchFrom, body.anchors, undefined, body.structure));
});
editorRoutes.post('/junction-preview', async (req, res) => {
  const { coordinate } = z.object({ coordinate: XYZ }).parse(req.body);
  res.json(await editorService.previewJunction(coordinate));
});
editorRoutes.post('/junctions', async (req, res) => {
  res.json(await editorService.saveJunction(JunctionSave.parse(req.body), identity(res)));
});
editorRoutes.post('/road-changesets', async (req, res) => {
  res.json(await editorService.saveRoad(RoadSave.parse(req.body), identity(res)));
});
editorRoutes.post('/places', async (req, res) => {
  res.json(await editorService.savePlace(PlaceSave.parse(req.body), identity(res)));
});
editorRoutes.delete('/roads/:id', async (req, res) => {
  const id = Uuid.parse(req.params.id);
  const body = z.object({ expectedRevision: z.number().int().positive(), sessionId: Uuid, leaseToken: Uuid, mutationId: Uuid }).parse(req.body);
  res.json(await editorService.retire('road', id, body, identity(res)));
});
editorRoutes.delete('/places/:id', async (req, res) => {
  const id = Uuid.parse(req.params.id);
  const body = z.object({ expectedRevision: z.number().int().positive(), sessionId: Uuid, leaseToken: Uuid, mutationId: Uuid }).parse(req.body);
  res.json(await editorService.retire('place', id, body, identity(res)));
});

/** Shared display colour of a road (null clears it). Other editors reload through the change feed. */
editorRoutes.put('/roads/:id/style', async (req, res) => {
  const id = Uuid.parse(req.params.id);
  res.json(await editorService.setRoadStyle(id, RoadStyleSave.parse(req.body), identity(res)));
});

/** Centerline + width estimated from several recorded walks of one passage; nothing is saved (the browser draws it as a draft). */
editorRoutes.post('/corridor-preview', async (req, res) => {
  const body = z.object({
    tracks: z.array(z.object({ runId: Uuid, fromSeq: z.number().int().optional(), toSeq: z.number().int().optional() })).min(1).max(30),
    zSource: z.enum(['run', 'terrain']).default('run'), phoneHeightM: z.number().min(0).max(2.5).default(1.1),
    stepM: z.number().min(0.25).max(10).default(1), searchRadiusM: z.number().min(0.5).max(30).default(6), simplifyM: z.number().min(0).max(5).default(0.3),
  }).parse(req.body);
  const tracks = [];
  for (const t of body.tracks) {
    const lo = Math.min(t.fromSeq ?? -Infinity, t.toSeq ?? Infinity), hi = Math.max(t.fromSeq ?? -Infinity, t.toSeq ?? Infinity);
    const rows = (await fusionRunsRepository.positions(t.runId, 'FINAL')).filter((p) => p.seq >= lo && p.seq <= hi);
    if (rows.length < 2) throw AppError.badRequest('TRACK_RANGE_EMPTY', `Run ${t.runId} has fewer than two FINAL points in that range`);
    tracks.push(rows.map((p) => ({ x: p.x + CAMPUS_FRAME.originE, y: p.y + CAMPUS_FRAME.originN, h: p.h })));
  }
  const ctx = await terrainContext();
  try {
    res.json(corridorCenterline(tracks, body, ctx ? (x, y) => terrain.sampleXY(ctx, x, y)?.height ?? null : undefined));
  } catch (err) { throw AppError.badRequest('CORRIDOR_FAILED', (err as Error).message); }
});
