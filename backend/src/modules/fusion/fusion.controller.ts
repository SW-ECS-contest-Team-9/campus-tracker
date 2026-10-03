import type { Request, Response } from 'express';
import { SessionIdParam } from '../sessions/session.dto.js';
import { FusedPositionsQuery, ReprocessRequest } from './fusion.dto.js';
import { fusionService } from './fusion.service.js';

export const fusionController = {
  // GET /api/v1/sessions/:sessionId/fused-positions?algorithmVersion=fusion-v1
  async list(req: Request, res: Response) {
    const { sessionId } = SessionIdParam.parse(req.params);
    const { algorithmVersion } = FusedPositionsQuery.parse(req.query);
    res.json(await fusionService.list(sessionId, algorithmVersion));
  },

  async spatialDecisions(req: Request, res: Response) {
    const { sessionId } = SessionIdParam.parse(req.params);
    const { algorithmVersion } = FusedPositionsQuery.parse(req.query);
    res.json(await fusionService.spatialDecisions(sessionId, algorithmVersion));
  },

  async sensorEvents(req: Request, res: Response) {
    const { sessionId } = SessionIdParam.parse(req.params);
    const { algorithmVersion } = FusedPositionsQuery.parse(req.query);
    res.json(await fusionService.sensorEvents(sessionId, algorithmVersion));
  },

  // GET /api/v1/sessions/:sessionId/fusion  (stored versions + live state)
  async summary(req: Request, res: Response) {
    const { sessionId } = SessionIdParam.parse(req.params);
    res.json(await fusionService.summary(sessionId));
  },

  // POST /api/v1/sessions/:sessionId/fusion/reprocess  { "algorithmVersion": "fusion-v1" }
  async reprocess(req: Request, res: Response) {
    const { sessionId } = SessionIdParam.parse(req.params);
    const { algorithmVersion, force } = ReprocessRequest.parse(req.body ?? {});
    res.json(await fusionService.reprocess(sessionId, algorithmVersion, force));
  },

  // GET /api/v1/fusion/versions
  async versions(_req: Request, res: Response) {
    res.json(await fusionService.versions());
  },
};
