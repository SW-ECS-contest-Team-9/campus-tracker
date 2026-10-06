// EPSG:5186 Transverse Mercator forward projection (same formula as backend/src/geo/tm.ts, checked against PostGIS).
const DEG = Math.PI / 180;
const A = 6378137;
const F = 1 / 298.257222101;
const LAT0 = 38;
const LON0 = 127;

function meridianArc(phi: number) {
  const e2 = F * (2 - F);
  const e4 = e2 * e2;
  const e6 = e4 * e2;
  return A * ((1 - e2 / 4 - (3 * e4) / 64 - (5 * e6) / 256) * phi
    - ((3 * e2) / 8 + (3 * e4) / 32 + (45 * e6) / 1024) * Math.sin(2 * phi)
    + ((15 * e4) / 256 + (45 * e6) / 1024) * Math.sin(4 * phi)
    - ((35 * e6) / 3072) * Math.sin(6 * phi));
}
const M0 = meridianArc(LAT0 * DEG);

/** WGS84/GRS80 latitude, longitude (degrees) -> EPSG:5186 easting/northing (m). */
export function tmForward(latitude: number, longitude: number): { x: number; y: number } {
  const e2 = F * (2 - F);
  const ep2 = e2 / (1 - e2);
  const phi = latitude * DEG;
  const sin = Math.sin(phi);
  const cos = Math.cos(phi);
  const tan = Math.tan(phi);
  const N = A / Math.sqrt(1 - e2 * sin * sin);
  const T = tan * tan;
  const C = ep2 * cos * cos;
  const a = (longitude - LON0) * DEG * cos;
  const x = N * (a + ((1 - T + C) * a ** 3) / 6 + ((5 - 18 * T + T * T + 72 * C - 58 * ep2) * a ** 5) / 120);
  const y = meridianArc(phi) - M0 + N * tan * (a * a / 2 + ((5 - T + 9 * C + 4 * C * C) * a ** 4) / 24 + ((61 - 58 * T + T * T + 600 * C - 330 * ep2) * a ** 6) / 720);
  return { x: 200000 + x, y: 600000 + y };
}

/** EPSG:5186 easting/northing (m) -> WGS84/GRS80 latitude, longitude (degrees). */
export function tmInverse(x: number, y: number): { latitude: number; longitude: number } {
  const e2 = F * (2 - F);
  const ep2 = e2 / (1 - e2);
  const M = M0 + y - 600000;
  const mu = M / (A * (1 - e2 / 4 - (3 * e2 * e2) / 64 - (5 * e2 ** 3) / 256));
  const e1 = (1 - Math.sqrt(1 - e2)) / (1 + Math.sqrt(1 - e2));
  const phi1 = mu + ((3 * e1) / 2 - (27 * e1 ** 3) / 32) * Math.sin(2 * mu)
    + ((21 * e1 * e1) / 16 - (55 * e1 ** 4) / 32) * Math.sin(4 * mu)
    + ((151 * e1 ** 3) / 96) * Math.sin(6 * mu)
    + ((1097 * e1 ** 4) / 512) * Math.sin(8 * mu);
  const sin = Math.sin(phi1);
  const cos = Math.cos(phi1);
  const tan = Math.tan(phi1);
  const C1 = ep2 * cos * cos;
  const T1 = tan * tan;
  const N1 = A / Math.sqrt(1 - e2 * sin * sin);
  const R1 = (A * (1 - e2)) / (1 - e2 * sin * sin) ** 1.5;
  const D = (x - 200000) / N1;
  const latitude = phi1 - ((N1 * tan) / R1) * (D * D / 2 - ((5 + 3 * T1 + 10 * C1 - 4 * C1 * C1 - 9 * ep2) * D ** 4) / 24
    + ((61 + 90 * T1 + 298 * C1 + 45 * T1 * T1 - 252 * ep2 - 3 * C1 * C1) * D ** 6) / 720);
  const longitudeOffset = (D - ((1 + 2 * T1 + C1) * D ** 3) / 6 + ((5 - 2 * C1 + 28 * T1 - 3 * C1 * C1 + 8 * ep2 + 24 * T1 * T1) * D ** 5) / 120) / cos;
  return { latitude: latitude / DEG, longitude: LON0 + longitudeOffset / DEG };
}
