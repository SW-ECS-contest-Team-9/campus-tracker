import { Router } from 'express';
import { terrainController } from './terrain.controller.js';

export const terrainRoutes = Router();
terrainRoutes.get('/', terrainController.summary);
terrainRoutes.get('/height', terrainController.height);
