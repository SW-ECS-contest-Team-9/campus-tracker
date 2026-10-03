import type { Request, Response } from 'express';
import type { CollectorIdentity } from '../../common/auth/jwt.js';
import {
  DiagnosticEventsRequest,
  ListSessionsQuery,
  SessionDiagnosticsRequest,
  SessionFinishRequest,
  SessionIdParam,
  SessionStartRequest,
  SyncCompleteRequest,
} from './session.dto.js';
import { sessionService } from './session.service.js';

export const sessionController = {
  // ---- Socket.IO /collector (called by collector.gateway, return value = ACK) ----
  start(identity: CollectorIdentity, payload: unknown) {
    return sessionService.start(identity, SessionStartRequest.parse(payload));
  },

  finish(identity: CollectorIdentity, payload: unknown) {
    return sessionService.finish(identity, SessionFinishRequest.parse(payload));
  },

  syncComplete(identity: CollectorIdentity, payload: unknown) {
    return sessionService.syncComplete(identity, SyncCompleteRequest.parse(payload));
  },

  diagnostics(identity: CollectorIdentity, payload: unknown) {
    return sessionService.mergeDiagnostics(identity, SessionDiagnosticsRequest.parse(payload));
  },

  diagnosticEvents(identity: CollectorIdentity, payload: unknown) {
    return sessionService.diagnosticEvents(identity, DiagnosticEventsRequest.parse(payload));
  },

  // ---- REST /api/v1/sessions ----
  async list(req: Request, res: Response) {
    res.json(await sessionService.list(ListSessionsQuery.parse(req.query)));
  },

  async get(req: Request, res: Response) {
    const { sessionId } = SessionIdParam.parse(req.params);
    res.json(await sessionService.detail(sessionId));
  },

  async locations(req: Request, res: Response) {
    const { sessionId } = SessionIdParam.parse(req.params);
    res.json(await sessionService.getLocations(sessionId));
  },
};
