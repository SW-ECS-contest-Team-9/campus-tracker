import type { Request, Response } from 'express';
import { z } from 'zod';
import { AppError } from '../../common/errors/app-error.js';
import { terrain } from '../../geo/terrain.js';
import { tmForward } from '../../geo/tm.js';

const HeightQuery = z.object({ lat: z.coerce.number().min(-90).max(90), lon: z.coerce.number().min(-180).max(180) });

export const terrainController = {
  /** Active terrain version (QA report, geoid) + building metadata. */
  async summary(_req: Request, res: Response) {
    const s = await terrain.summary();
    if (!s) throw AppError.notFound('TERRAIN_UNAVAILABLE', 'No active terrain version (run terrain:import)');
    res.json(s);
  },

  /** Ground height at a WGS84 point: orthometric (Incheon MSL) and ellipsoidal, with its uncertainty. */
  async height(req: Request, res: Response) {
    const { lat, lon } = HeightQuery.parse(req.query);
    const ctx = await terrain.context(await terrain.activeVersion());
    if (!ctx) throw AppError.notFound('TERRAIN_UNAVAILABLE', 'No active terrain version (run terrain:import)');
    const p = tmForward(lat, lon);
    const sample = terrain.sampleXY(ctx, p.x, p.y);
    if (!sample) throw AppError.notFound('OUTSIDE_TERRAIN', 'The point is outside the terrain coverage');
    const near = terrain.buildingAt(ctx, p.x, p.y);
    res.json({
      versionId: ctx.versionId,
      orthometricHeight: sample.height,
      ellipsoidalHeight: sample.height + ctx.geoidSeparation,
      geoidSeparation: ctx.geoidSeparation,
      sigma: sample.sigma,
      slope: sample.slope,
      terrainModified: sample.modified,
      building: near.building ? { buildingId: near.building.buildingId, name: near.building.name, groundFloors: near.building.groundFloors, undergroundFloors: near.building.undergroundFloors } : null,
      distanceToBuildingM: near.distance,
    });
  },
};
