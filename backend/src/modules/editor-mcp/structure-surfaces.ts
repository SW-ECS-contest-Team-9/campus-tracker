// The walkable tops of the built structures (frontend/public/structures/*.geojson, docs/audit/g02/STRUCTURES.md), for the
// terrain check of validate_network. The campus ground is built mass (AGENTS.md): a road on a deck, a landing, a stair step,
// or a platform the terrain grid does not carry is on the ground there, and a road in an underground void is on its
// floor. Read the way the frontend reads them (frontend/src/structures.ts parseStructures); read-only, never throws.
import fs from 'node:fs';
import path from 'node:path';
import { BACKEND_DIR } from '../../deploy/manifest.js';

type Ring = [number, number][];
export interface StructureSurface {
  id: string;
  /** `type` of the schema (platform, stair_step, landing, deck, ramp, surface, curb) or `void` (then the height is its floor). */
  type: string;
  bbox: [number, number, number, number];
  /** outer ring first, then holes */
  rings: Ring[];
  height: (x: number, y: number) => number;
}
export interface SurfaceHit { id: string; type: string; z: number }

/** Box types a road can run on. Not: wall, tree, planter, canopy, barrier (nobody walks on them; a low wall in an underground way would match a road by chance). */
export const WALKABLE_TYPES = ['platform', 'stair_step', 'landing', 'deck', 'ramp', 'surface', 'curb'];
export const STRUCTURES_DIR = path.join(BACKEND_DIR, '..', 'frontend', 'public', 'structures');

const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const pair = (v: unknown): v is number[] => Array.isArray(v) && v.length >= 2 && num(v[0]) && num(v[1]);

function profileHeight(v: any): ((x: number, y: number) => number) | null {
  if (!v || !pair(v.origin) || !pair(v.direction) || !Array.isArray(v.points) || v.points.length < 2 || !v.points.every(pair)) return null;
  const len = Math.hypot(v.direction[0], v.direction[1]);
  if (!(len > 0)) return null;
  const [ox, oy] = v.origin, dx = v.direction[0] / len, dy = v.direction[1] / len;
  const pts = [...(v.points as number[][])].sort((a, b) => a[0] - b[0]);
  return (x, y) => {
    const d = (x - ox) * dx + (y - oy) * dy;
    if (d <= pts[0][0]) return pts[0][1];
    for (let i = 1; i < pts.length; i++) if (d <= pts[i][0]) return pts[i - 1][1] + ((pts[i][1] - pts[i - 1][1]) * (d - pts[i - 1][0])) / (pts[i][0] - pts[i - 1][0] || 1);
    return pts[pts.length - 1][1];
  };
}

/** The walkable surfaces of one structures FeatureCollection (EPSG:5186). Same height rules as parseStructures. */
export function surfacesOf(fc: any, file = ''): StructureSurface[] {
  if (!Array.isArray(fc?.features)) return [];
  const out: StructureSurface[] = [];
  fc.features.forEach((f: any, i: number) => {
    const p = f?.properties ?? {};
    const kind = String(p.kind ?? ''), type = String(p.type ?? (kind || 'unknown'));
    const isVoid = kind === 'void' || type === 'void';
    if (!isVoid && !WALKABLE_TYPES.includes(type)) return;
    const profile = profileHeight(p.topProfile);
    const box = num(p.fromM) && num(p.toM) && p.toM > p.fromM;
    let height: ((x: number, y: number) => number) | null = null;
    if (isVoid) height = box ? () => p.fromM : null;
    else if (profile && kind !== 'platform' && num(p.thicknessM) && p.thicknessM > 0) height = profile;
    else if ((profile || num(p.topM)) && num(p.bottomM)) height = profile ?? (() => p.topM);
    else if (box) height = () => p.toM;
    if (!height) return;
    const g = f?.geometry;
    const polys = g?.type === 'Polygon' ? [g.coordinates] : g?.type === 'MultiPolygon' ? g.coordinates : [];
    for (const poly of polys) {
      if (!Array.isArray(poly) || !poly.length || !poly.every((r: unknown) => Array.isArray(r) && r.length >= 3 && r.every(pair))) continue;
      const rings: Ring[] = poly.map((r: number[][]) => r.map((c) => [c[0], c[1]] as [number, number]));
      const xs = rings[0].map((c) => c[0]), ys = rings[0].map((c) => c[1]);
      out.push({ id: String(p.id ?? `${file}#${i}`), type: isVoid ? 'void' : type, rings, height, bbox: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)] });
    }
  });
  return out;
}

/** Every *.geojson of the structures folder (the frontend's index.json is made from the same folder). A missing folder gives []. */
export function loadStructureSurfaces(dir = STRUCTURES_DIR): StructureSurface[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith('.geojson')).sort().flatMap((f) => {
    try { return surfacesOf(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8').replace(/^﻿/, '')), f); } catch { return []; }
  });
}

function ringContains(x: number, y: number, ring: Ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** The structure surfaces under a plan point and their heights there. */
export function surfacesAt(surfaces: StructureSurface[]): (x: number, y: number) => SurfaceHit[] {
  return (x, y) => surfaces.filter((s) => x >= s.bbox[0] && x <= s.bbox[2] && y >= s.bbox[1] && y <= s.bbox[3]
    && ringContains(x, y, s.rings[0]) && !s.rings.slice(1).some((h) => ringContains(x, y, h)))
    .map((s) => ({ id: s.id, type: s.type, z: s.height(x, y) }));
}
