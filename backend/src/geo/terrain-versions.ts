export interface TerrainVersionGrid {
  srid: number; verticalDatum: string; geoidSeparationM: number;
  originX: number; originY: number; resolutionM: number; width: number; height: number;
}

/** Fields in which two terrain versions differ. Switching the active version is only safe when this is empty:
 * roads, sessions and the scene were built on the same grid extent, vertical datum and geoid separation.
 */
export function gridDifferences(a: TerrainVersionGrid, b: TerrainVersionGrid): string[] {
  const keys: (keyof TerrainVersionGrid)[] = ['srid', 'verticalDatum', 'geoidSeparationM', 'originX', 'originY', 'resolutionM', 'width', 'height'];
  return keys.filter((k) => a[k] !== b[k]);
}
