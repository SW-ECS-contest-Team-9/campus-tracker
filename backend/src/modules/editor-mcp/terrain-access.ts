// Active DEM access for the MCP tools (the same surface fusion and the editor use).
import { terrain } from '../../geo/terrain.js';
import { round2 } from './geometry.js';

export async function terrainContext() {
  return terrain.context(await terrain.activeVersion());
}

/** Ground height, its uncertainty and the building at an EPSG:5186 point; null outside the DEM. */
export async function groundAt(x: number, y: number) {
  const ctx = await terrainContext();
  const sample = ctx && terrain.sampleXY(ctx, x, y);
  if (!ctx || !sample) return null;
  const near = terrain.buildingAt(ctx, x, y);
  return {
    z: round2(sample.height), sigmaM: round2(sample.sigma), slope: round2(sample.slope),
    building: near.building ? { buildingId: near.building.buildingId, name: near.building.name } : null,
    distanceToBuildingM: Number.isFinite(near.distance) ? round2(near.distance) : null,
  };
}
