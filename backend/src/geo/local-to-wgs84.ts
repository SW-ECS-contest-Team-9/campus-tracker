import { radiiOfCurvature, type LocalOrigin, type LocalPoint } from './wgs84.js';

const DEG = Math.PI / 180;

/** Inverse of wgs84ToLocal: local East/North/Up meters -> WGS84 (lat, lon, ellipsoidal height). */
export function localToWgs84(origin: LocalOrigin, p: LocalPoint): { latitude: number; longitude: number; height: number } {
  const { meridional, primeVertical } = radiiOfCurvature(origin.latitude);
  return {
    latitude: origin.latitude + p.y / (meridional + origin.height) / DEG,
    longitude: origin.longitude + p.x / ((primeVertical + origin.height) * Math.cos(origin.latitude * DEG)) / DEG,
    height: origin.height + p.z,
  };
}
