import { Router } from 'express';
import { sessionController } from './session.controller.js';
import { markerController } from '../markers/marker.controller.js';
import { fusionController } from '../fusion/fusion.controller.js';

export const sessionRoutes = Router();

sessionRoutes.get('/', sessionController.list);
sessionRoutes.get('/:sessionId', sessionController.get);
sessionRoutes.get('/:sessionId/locations', sessionController.locations);
sessionRoutes.get('/:sessionId/markers', markerController.listBySession);
sessionRoutes.get('/:sessionId/fused-positions', fusionController.list);
sessionRoutes.get('/:sessionId/spatial-decisions', fusionController.spatialDecisions);
sessionRoutes.get('/:sessionId/fusion-events', fusionController.sensorEvents);
sessionRoutes.get('/:sessionId/fusion', fusionController.summary);
sessionRoutes.post('/:sessionId/fusion/reprocess', fusionController.reprocess);
