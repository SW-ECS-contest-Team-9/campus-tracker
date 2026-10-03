import type { Request, Response } from 'express';
import { env } from '../../config/env.js';
import type { CollectorIdentity } from '../../common/auth/jwt.js';
import {
  CollectorCodeParam,
  CollectorStatusRequest,
  CreateCollectorRequest,
  DeleteCollectorRequest,
  LoginRequest,
} from './collector.dto.js';
import { collectorService } from './collector.service.js';

export const collectorController = {
  async login(req: Request, res: Response) {
    const body = LoginRequest.parse(req.body);
    // Echo back the exact host:port the phone reached us on (or PUBLIC_BASE_URL behind a TLS proxy),
    // so the app never hard-codes socket addresses.
    const origin = env.PUBLIC_BASE_URL?.replace(/\/$/, '') ?? `${req.protocol}://${req.get('host')}`;
    res.json(await collectorService.login(body, origin));
  },

  // Socket.IO /collector collector:status
  status(identity: CollectorIdentity, payload: unknown) {
    return collectorService.reportStatus(identity, CollectorStatusRequest.parse(payload));
  },

  async list(_req: Request, res: Response) {
    res.json(await collectorService.listWithState());
  },

  async create(req: Request, res: Response) {
    const body = CreateCollectorRequest.parse(req.body ?? {});
    res.status(201).json(await collectorService.create(body));
  },

  async summary(req: Request, res: Response) {
    const { collectorId } = CollectorCodeParam.parse(req.params);
    res.json(await collectorService.getSummary(collectorId));
  },

  async remove(req: Request, res: Response) {
    const { collectorId } = CollectorCodeParam.parse(req.params);
    const { confirmText } = DeleteCollectorRequest.parse(req.body ?? {});
    res.json(await collectorService.remove(collectorId, confirmText));
  },
};
