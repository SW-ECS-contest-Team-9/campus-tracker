import { Router } from 'express';
import { z } from 'zod';
import { Uuid } from '../../common/dto.js';
import { editorAuth } from './editor.auth.js';
import { Anchor, BranchFrom, EditorQuery, JunctionSave, LeaseRelease, LeaseRequest, PlaceSave, RoadSave, XYZ } from './editor.dto.js';
import { editorService } from './editor.service.js';
import { editorOps } from './editor.ops.js';
import type { CollectorIdentity } from '../../common/auth/jwt.js';
import { editorBroadcast } from '../../realtime/editor.gateway.js';

export const editorRoutes = Router();
editorRoutes.use(editorAuth);
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
  const body = z.object({ coordinates: z.array(XYZ).min(2).max(20_000), levelId: z.string().max(80).nullish(), branchFrom: BranchFrom.optional(), anchors: z.array(Anchor).max(50).default([]) }).parse(req.body);
  res.json(await editorService.previewTopology(body.coordinates, body.levelId ?? null, body.branchFrom, body.anchors));
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
