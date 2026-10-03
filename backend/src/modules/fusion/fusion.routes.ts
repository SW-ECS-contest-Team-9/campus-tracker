import { Router } from 'express';
import { fusionController } from './fusion.controller.js';

export const fusionRoutes = Router();

fusionRoutes.get('/versions', fusionController.versions);
