import { radiiOfCurvature, type LocalOrigin, type LocalPoint } from './wgs84.js';

const DEG = Math.PI / 180;

/**
 * WGS84 (lat, lon, ellipsoidal height) -> local East/North/Up meters around `origin`.
 * Local tangent-plane approximation using the ellipsoid's radii at the origin latitude.
 * Error stays at the centimeter level within a few km, which covers a campus.
 */
export function wgs84ToLocal(origin: LocalOrigin, latitude: number, longitude: number, height: number): LocalPoint {
  const { meridional, primeVertical } = radiiOfCurvature(origin.latitude);
  let dLon = longitude - origin.longitude;
  if (dLon > 180) dLon -= 360;
  if (dLon < -180) dLon += 360;
  return {
    x: dLon * DEG * (primeVertical + origin.height) * Math.cos(origin.latitude * DEG),
    y: (latitude - origin.latitude) * DEG * (meridional + origin.height),
    z: height - origin.height,
  };
}
