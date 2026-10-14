import { arkitRoutes } from '../arkit/arkit.routes.js';
import { Router } from 'express';
import { sessionController } from './session.controller.js';
import { markerController } from '../markers/marker.controller.js';
import { fusionController } from '../fusion/fusion.controller.js';

export const sessionRoutes = Router();

sessionRoutes.use('/:sessionId/arkit', arkitRoutes);

sessionRoutes.get('/', sessionController.list);
sessionRoutes.get('/:sessionId', sessionController.get);
sessionRoutes.get('/:sessionId/locations', sessionController.locations);
sessionRoutes.get('/:sessionId/diagnostic-events', sessionController.diagnosticEventList);
sessionRoutes.post('/:sessionId/interrupt', sessionController.interrupt);
sessionRoutes.get('/:sessionId/markers', markerController.listBySession);
sessionRoutes.get('/:sessionId/fused-positions', fusionController.list);
sessionRoutes.get('/:sessionId/spatial-decisions', fusionController.spatialDecisions);
sessionRoutes.get('/:sessionId/fusion-events', fusionController.sensorEvents);
sessionRoutes.get('/:sessionId/fusion', fusionController.summary);
sessionRoutes.post('/:sessionId/fusion/reprocess', fusionController.reprocess);
