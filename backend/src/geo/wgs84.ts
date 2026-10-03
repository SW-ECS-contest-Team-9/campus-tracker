// WGS84 ellipsoid constants and local radii of curvature.
export const WGS84_A = 6378137.0;
export const WGS84_F = 1 / 298.257223563;
export const WGS84_E2 = WGS84_F * (2 - WGS84_F);

const DEG = Math.PI / 180;

/** Meridional (north-south) and prime-vertical (east-west) radii at a latitude, in meters. */
export function radiiOfCurvature(latitudeDeg: number) {
  const s = Math.sin(latitudeDeg * DEG);
  const w = Math.sqrt(1 - WGS84_E2 * s * s);
  return {
    meridional: (WGS84_A * (1 - WGS84_E2)) / (w * w * w), // M
    primeVertical: WGS84_A / w, // N
  };
}

/** Local frame origin. height is the WGS84 ellipsoidal height of the origin (meters). */
export interface LocalOrigin {
  latitude: number;
  longitude: number;
  height: number;
}

/** East / North / Up in meters relative to an origin. +X = East, +Y = North, +Z = Up. */
export interface LocalPoint {
  x: number;
  y: number;
  z: number;
}
