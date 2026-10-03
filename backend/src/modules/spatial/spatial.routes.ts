import { Router } from 'express';
import { spatialController } from './spatial.controller.js';

export const spatialRoutes = Router();
spatialRoutes.get('/map', spatialController.map);
