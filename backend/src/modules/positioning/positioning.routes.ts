import { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import { verifyAccessToken, type CollectorIdentity } from '../../common/auth/jwt.js';
import { AppError } from '../../common/errors/app-error.js';
import { env } from '../../config/env.js';
import { Uuid } from '../../common/dto.js';
import { collectorService } from '../collectors/collector.service.js';
import { BeaconListQuery } from './beacon.dto.js';
import { beaconRepository } from './beacon.repository.js';
import { beaconService } from './beacon.service.js';

// /api/v1/positioning: beacon config for the apps (collector token) and the registry for administrators.

/** Any collector-account token (the same passwordless JWT the apps and the editor use). */
export const collectorAuth: RequestHandler = async (req, res, next) => {
  const token = req.header('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token) throw AppError.unauthorized('TOKEN_REQUIRED', 'Sign in with a collector account');
  const identity = verifyAccessToken(token);
  await collectorService.touchDevice(identity);
  res.locals.identity = identity;
  next();
};

/** Registry changes: a collector token whose collector ID is listed in POSITIONING_ADMIN_COLLECTORS. */
export const positioningAdminAuth: RequestHandler = (req, res, next) => {
  const identity = res.locals.identity as CollectorIdentity;
  if (!env.positioningAdmins.has(identity.collectorId.toUpperCase())) {
    throw AppError.forbidden('POSITIONING_ADMIN_REQUIRED', 'This collector account may not change the beacon registry');
  }
  next();
};

const actor = (res: { locals: Record<string, unknown> }) => (res.locals.identity as CollectorIdentity).collectorId;
const id = (v: unknown, code: string) => {
  const r = Uuid.safeParse(v);
  if (!r.success) throw AppError.notFound(code, 'Not found');
  return r.data;
};

export const positioningRoutes = Router();
positioningRoutes.use(collectorAuth);

positioningRoutes.get('/beacon-config', async (req, res) => {
  const { etag, body } = await beaconService.config();
  res.setHeader('ETag', etag);
  res.setHeader('Cache-Control', `private, max-age=${env.BEACON_CONFIG_MAX_AGE_S}`);
  const known = req.header('if-none-match');
  if (known && known.split(',').map((t) => t.trim()).includes(etag)) return void res.status(304).end();
  res.json(body);
});

const admin = Router();
admin.use(positioningAdminAuth);

admin.get('/beacons', async (req, res) => {
  const q = BeaconListQuery.parse(req.query);
  res.json({ beacons: await beaconRepository.listBeacons(q), configVersion: (await beaconRepository.revision()).revision });
});
admin.post('/beacons', async (req, res) => res.status(201).json(await beaconService.createBeacon(req.body, actor(res))));
admin.get('/beacons/:beaconId', async (req, res) => res.json(await beaconService.getBeacon(id(req.params.beaconId, 'BEACON_NOT_FOUND'))));
admin.patch('/beacons/:beaconId', async (req, res) =>
  res.json(await beaconService.updateBeacon(id(req.params.beaconId, 'BEACON_NOT_FOUND'), req.body, actor(res))));
/** Soft delete (disable). There is no hard delete: stored observations keep their beacon reference. */
admin.delete('/beacons/:beaconId', async (req, res) =>
  res.json(await beaconService.disableBeacon(id(req.params.beaconId, 'BEACON_NOT_FOUND'), actor(res))));
admin.post('/beacons/:beaconId/disable', async (req, res) =>
  res.json(await beaconService.disableBeacon(id(req.params.beaconId, 'BEACON_NOT_FOUND'), actor(res))));
admin.put('/beacons/:beaconId/anchor', async (req, res) => {
  const body = z.object({ anchorId: Uuid.nullable() }).strict().parse(req.body);
  res.json(await beaconService.updateBeacon(id(req.params.beaconId, 'BEACON_NOT_FOUND'), body, actor(res)));
});

admin.get('/anchors', async (_req, res) => res.json({ anchors: await beaconRepository.listAnchors() }));
admin.post('/anchors', async (req, res) => res.status(201).json(await beaconService.createAnchor(req.body, actor(res))));
admin.patch('/anchors/:anchorId', async (req, res) =>
  res.json(await beaconService.updateAnchor(id(req.params.anchorId, 'ANCHOR_NOT_FOUND'), req.body, actor(res))));

admin.get('/discovered', async (req, res) => res.json({ discovered: await beaconService.discovered(req.query) }));
admin.get('/survey-uuids', async (_req, res) => res.json({ surveyUuids: await beaconRepository.surveyUuids() }));
admin.post('/survey-uuids', async (req, res) => res.status(201).json(await beaconService.addSurveyUuid(req.body, actor(res))));
admin.delete('/survey-uuids/:uuid', async (req, res) => res.json(await beaconService.removeSurveyUuid(id(req.params.uuid, 'SURVEY_UUID_NOT_FOUND'))));
/** Who may register beacons: lets the registration page explain a 403 before the user fills the form. */
admin.get('/me', (_req, res) => res.json({ collectorId: actor(res), admin: true }));

admin.get('/calibrations', async (_req, res) => res.json({ calibrations: await beaconRepository.calibrations() }));
admin.put('/calibrations', async (req, res) => res.json(await beaconService.upsertCalibration(req.body, actor(res))));

positioningRoutes.use('/admin', admin);
