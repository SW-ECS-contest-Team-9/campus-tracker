import type { Request, Response } from 'express';
import type { CollectorIdentity } from '../../common/auth/jwt.js';
import { SessionIdParam } from '../sessions/session.dto.js';
import { MarkerCreateRequest } from './marker.dto.js';
import { markerService } from './marker.service.js';

export const markerController = {
  // Socket.IO /collector marker:create
  create(identity: CollectorIdentity, payload: unknown) {
    return markerService.create(identity, MarkerCreateRequest.parse(payload));
  },

  // REST GET /api/v1/sessions/:sessionId/markers
  async listBySession(req: Request, res: Response) {
    const { sessionId } = SessionIdParam.parse(req.params);
    res.json(await markerService.listBySession(sessionId));
  },
};
