// Transverse Mercator forward projection (Snyder 1987, eq. 8-9..8-10), used for EPSG:5186
// (Korea 2000 / Central Belt 2010: GRS80, lat0 38, lon0 127, k0 1, FE 200 000, FN 600 000).
// Millimetre-level within the few km of the campus; checked against PostGIS in the unit tests.
const DEG = Math.PI / 180;

export interface TmParams { a: number; f: number; lat0: number; lon0: number; k0: number; falseEasting: number; falseNorthing: number }

export const EPSG_5186: TmParams = { a: 6378137, f: 1 / 298.257222101, lat0: 38, lon0: 127, k0: 1, falseEasting: 200000, falseNorthing: 600000 };

function meridianArc(p: TmParams, phi: number) {
  const e2 = p.f * (2 - p.f);
  const e4 = e2 * e2;
  const e6 = e4 * e2;
  return p.a * ((1 - e2 / 4 - (3 * e4) / 64 - (5 * e6) / 256) * phi
    - ((3 * e2) / 8 + (3 * e4) / 32 + (45 * e6) / 1024) * Math.sin(2 * phi)
    + ((15 * e4) / 256 + (45 * e6) / 1024) * Math.sin(4 * phi)
    - ((35 * e6) / 3072) * Math.sin(6 * phi));
}

/** WGS84/GRS80 latitude, longitude (degrees) -> projected easting/northing (m). */
export function tmForward(latitude: number, longitude: number, p: TmParams = EPSG_5186): { x: number; y: number } {
  const e2 = p.f * (2 - p.f);
  const ep2 = e2 / (1 - e2);
  const phi = latitude * DEG;
  const sin = Math.sin(phi);
  const cos = Math.cos(phi);
  const tan = Math.tan(phi);
  const N = p.a / Math.sqrt(1 - e2 * sin * sin);
  const T = tan * tan;
  const C = ep2 * cos * cos;
  const A = (longitude - p.lon0) * DEG * cos;
  const M = meridianArc(p, phi);
  const M0 = meridianArc(p, p.lat0 * DEG);
  const x = p.k0 * N * (A + ((1 - T + C) * A ** 3) / 6 + ((5 - 18 * T + T * T + 72 * C - 58 * ep2) * A ** 5) / 120);
  const y = p.k0 * (M - M0 + N * tan * (A * A / 2 + ((5 - T + 9 * C + 4 * C * C) * A ** 4) / 24 + ((61 - 58 * T + T * T + 600 * C - 330 * ep2) * A ** 6) / 720));
  return { x: p.falseEasting + x, y: p.falseNorthing + y };
}
