import { Router } from 'express';
import { collectorController } from './collector.controller.js';

export const collectorRoutes = Router();

collectorRoutes.post('/login', collectorController.login);
collectorRoutes.get('/', collectorController.list);
collectorRoutes.post('/', collectorController.create);
collectorRoutes.get('/:collectorId', collectorController.summary);
collectorRoutes.delete('/:collectorId', collectorController.remove);
