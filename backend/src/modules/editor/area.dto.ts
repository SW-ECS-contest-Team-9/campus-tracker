import { z } from 'zod';

const AreaRing = z.array(z.tuple([
  z.number().finite().min(100000).max(300000),
  z.number().finite().min(450000).max(650000),
])).min(3).max(2000);

export const AreaSave = z.object({
  name: z.string().trim().min(1).max(160),
  kind: z.enum(['plaza', 'courtyard', 'lobby', 'parking', 'other']),
  elevationM: z.number().finite().min(-100).max(2000),
  buildingId: z.string().trim().max(80).nullish(),
  floor: z.string().trim().max(80).nullish(),
  note: z.string().max(2000).nullish(),
  coordinates: AreaRing,
  holes: z.array(AreaRing).max(100).optional(),
});

/** Close the boundary without repeating the final vertex. Geometry validity is checked by PostGIS. */
export function areaPolygon(coordinates: [number, number][], holes: [number, number][][] = []) {
  const rings = [coordinates, ...holes].map(points => {
    const ring = points.map(p => [...p]);
    const first = ring[0], last = ring.at(-1)!;
    if (first[0] !== last[0] || first[1] !== last[1]) ring.push([...first]);
    return ring;
  });
  return { type: 'Polygon', coordinates: rings };
}
