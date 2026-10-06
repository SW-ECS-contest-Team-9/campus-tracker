// Campus-wide metric frame shared by every trajectory, map layer and comparison (docs/MOBILITY_MAP_PLAN.md 4.1).
// x/y = EPSG:5186 easting/northing minus a fixed campus origin (meters; scale error < 2e-8, grid convergence 0.008°
// on this campus, i.e. effectively East/North), z = orthometric height (Incheon MSL) = ellipsoidal - geoid N.
// Engines may keep their own internal frames: their WGS84 outputs are converted here exactly.
import { tmForward, tmInverse } from './tm.js';

export interface CampusFrame {
  id: string;
  originE: number;
  originN: number;
  /** KNGeoid18 geoid separation on the campus (ellipsoidal = orthometric + N) */
  geoidN: number;
}

export const CAMPUS_FRAME: CampusFrame = { id: 'skuniv-5186-v1', originE: 201_100, originN: 557_250, geoidN: 23.377 };

export interface CampusPoint { x: number; y: number }

export function toCampus(latitude: number, longitude: number, f: CampusFrame = CAMPUS_FRAME): CampusPoint {
  const p = tmForward(latitude, longitude);
  return { x: p.x - f.originE, y: p.y - f.originN };
}

export function fromCampus(x: number, y: number, f: CampusFrame = CAMPUS_FRAME): { latitude: number; longitude: number } {
  return tmInverse(x + f.originE, y + f.originN);
}

export const orthometricFromEllipsoidal = (h: number, f: CampusFrame = CAMPUS_FRAME) => h - f.geoidN;
export const ellipsoidalFromOrthometric = (h: number, f: CampusFrame = CAMPUS_FRAME) => h + f.geoidN;
