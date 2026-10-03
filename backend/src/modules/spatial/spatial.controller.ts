import type { Request, Response } from 'express';
import { z } from 'zod';
import { spatial } from '../../geo/spatial.js';

const MapQuery = z.object({ mapVersionId: z.string().trim().min(1).max(64).optional() });

export const spatialController = {
  async map(req: Request, res: Response) {
    const { mapVersionId } = MapQuery.parse(req.query);
    res.json(await spatial.geoJson(mapVersionId));
  },
};
