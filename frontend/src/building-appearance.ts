// How a building looks beyond its plain block (F07): wall colour, window rows per storey, a pitched roof with an
// eave. The record comes from the building notes through the scene API (SceneBuilding.appearance); nothing here is
// measured from photos, the shapes are schematic (square panels, a roof inset by a fixed run). A window has the size of its
// style unless the note gives the building its own (Z11: width, height, spacing, sill, paired windows).
// Pure geometry in EPSG:5186 metres + MSL heights (tested in test/building-appearance.test.ts); campus-map.ts draws it.
import earcut from 'earcut';
import type { BuildingAppearance } from './api';
import { polygonOps } from './polygon-ops';

export type XY = number[];
/** Triangles, three vertices each: positions x, y, z / unit normals / colours r, g, b (0-255). */
export type Mesh = { positions: number[]; normals: number[]; colors: number[] };
export type DecorOptions = {
  /** Top (MSL) of another building standing at this point, or -Infinity: a wall behind it gets no windows below that, and no roof slope. */
  neighbourTop?: (x: number, y: number) => number;
  /** true: this point lies on a cross-section cut (the face there is not a wall). */
  cut?: (x: number, y: number) => boolean;
  /** B12 (a wing): true inside the block the wing leans on; the wing has no wall and no eave there and runs `partyBackM` further in, to that block's wall. */
  party?: (x: number, y: number) => boolean;
  partyBackM?: number;
};

type RGB = [number, number, number];
const hex = (css: string): RGB => [1, 3, 5].map((i) => parseInt(css.slice(i, i + 2), 16)) as RGB;

/** Wall and roof colours per material word of the notes; `color` in the record replaces them. */
export const WALL_COLORS: Record<string, string> = {
  brick: '#8a4a3c', glass: '#4f8fa8', stone: '#d9d2c2', concrete: '#a9a8a2', ivy: '#4d6b3a', panel: '#c9c3b4', metal: '#5b6068', white: '#dcd8cd',
};
export const ROOF_COLORS: Record<string, string> = { tile: '#4a4d52', concrete: '#b5b3ac', glass: '#3f7890', green: '#5f8a5a', metal: '#4d5258', court: '#4f9a63' };
const WINDOW = { glass: '#6f8794', frame: '#d3d8d5', dormer: '#aeb4b8', cornice: '#d8d4c8', infill: '#8e8f8c' };

export const wallColor = (a: BuildingAppearance) => a.wallColor ?? WALL_COLORS[a.wall] ?? WALL_COLORS.panel;
const roofColor = (a: BuildingAppearance) => a.roof?.color ?? ROOF_COLORS[a.roof?.material ?? ''] ?? ROOF_COLORS.concrete;
const rise = (a: BuildingAppearance | null | undefined) => (a?.roof?.type !== 'hipped' ? 0 : a.roof.eaveTopM !== undefined && a.roof.ridgeM !== undefined ? a.roof.ridgeM - a.roof.eaveTopM : a.roof.riseM ?? 3);

/** P02 a roof in one plane (`shed`): its height at a point, from a profile along a direction (the same form as a structure's topProfile). */
export function planeAt(plane: { origin: number[]; direction: number[]; points: number[][] }) {
  const len = Math.hypot(plane.direction[0], plane.direction[1]) || 1, d = [plane.direction[0] / len, plane.direction[1] / len], pts = plane.points;
  return (x: number, y: number) => {
    const s = (x - plane.origin[0]) * d[0] + (y - plane.origin[1]) * d[1];
    if (s <= pts[0][0]) return pts[0][1];
    for (let i = 1; i < pts.length; i++) if (s <= pts[i][0]) return pts[i - 1][1] + ((pts[i][1] - pts[i - 1][1]) * (s - pts[i - 1][0])) / (pts[i][0] - pts[i - 1][0]);
    return pts[pts.length - 1][1];
  };
}
const shedOf = (a: BuildingAppearance | null | undefined) => (a?.roof?.type === 'shed' && a.roof.plane ? planeAt(a.roof.plane) : null);
/** Top of the walls: a pitched roof takes its rise half below and half above the stored (flat) roof height. */
export const wallTopM = (roofM: number, a: BuildingAppearance | null | undefined) => a?.roof?.eaveTopM ?? roofM - rise(a) / 2;
/** B12: true when the walls stand inside the footprint (a deep eave) or the footprint has lower wings: `decorate` then draws the walls itself and the plain block is left out. */
export const ownWalls = (a: BuildingAppearance | null | undefined) => !!a && ((a.roof?.overhangM ?? 0) > 0 || !!a.wings?.length || !!shedOf(a));
/** B12 the deep eave and the giant order: fascia of the eave, soffit and rafters, corner piers of a porch and how deep it is, the capital, the attic strip. */
const CLASSICAL = { fasciaM: 0.35, soffit: '#d6cbb4', rafter: '#b9ad94', rafterPitch: 1.1, pierM: 1.5, porchM: 2.2, capitalM: 0.5, beam: '#e3ddcf', attic: '#33373a', column: '#ece8de', shade: 0.78 };

/** Window layout per style: spacing and width along the wall, sill and head above the floor (head also limited by the storey). */
const STYLES = {
  rows: { pitch: 3.2, width: 1.5, sill: 0.95, head: 2.45, gap: 0.5 },
  bands: { pitch: 6, width: 5.5, sill: 1.0, head: 2.3, gap: 0.6 },
  curtain: { pitch: 1.8, width: 1.66, sill: 0.14, head: 99, gap: 0.14 },
  arches: { pitch: 4.2, width: 3.0, sill: 1.0, head: 2.6, gap: 0.5 },
  // one tall arched bay through all the storeys (Z07): glass from the lowest sill to a round head under the eave, a band at every floor
  bays: { pitch: 4.6, width: 3.2, sill: 0.6, head: 99, gap: 0.5 },
  // Z09: a small window with a round head on every storey
  archrows: { pitch: 3.2, width: 1.3, sill: 0.95, head: 2.0, gap: 0.45 },
  // Z09: straight piers through all the storeys with deep balconies between them (a dark recess, a railing band and a window strip per floor, a beam on top)
  piers: { pitch: 4.6, width: 3.7, sill: 0, head: 99, gap: 0 },
  // P02: an arch that binds all the storeys into one tall bay between stone piers; inside it a grid of windows over spandrel panels in two colours, a dark panel in the arch head
  archbays: { pitch: 5.8, width: 1.8, sill: 1.1, head: 2.4, gap: 0.3 },
} as const;
/** P02 the tall arch bay (style `archbays`): the pier between two bays and how far it stands out, the dark head panel, the second spandrel colour, the window frame, the height of the arch head. */
const ARCHBAY = { pierW: 0.95, depth: 0.4, head: '#3d4043', alt: '#77787a', frame: '#e9ebe8', headM: 2.6 };
/** Z11 paired windows: the pier between the two windows of a pair. */
const PAIR_GAP = 0.25;
/** The bays between straight piers (style `piers`): how far the piers stand out, the balcony railing band, the window strip above it. */
const PIERS = { depth: 0.9, railM: 1.15, railDepth: 0.45, rail: '#6d6f73', recess: '#3a3d40', glassFrom: 1.35, glassTo: 2.5, beam: 1.0 };
/** A row of tall columns in front of a wall face (Z07): column width and spacing, how far they stand out, the beam on top. */
/** A double eave (roof.tiers 2): the wall band between the two roofs and how far the upper eave stands out of it. */
const TIERS = { bandM: 0.9, eaveM: 0.7, band: '#cfc9ba' };
const COLONNADE = { pitch: 4.4, width: 0.9, depth: 0.6, beam: 1.3, recess: '#3b3f42', color: '#e6e3da' };

/** Compass direction (degrees, north 0, east 90) an outward wall normal faces. */
export const azimuth = (n: XY) => ((Math.atan2(n[0], n[1]) * 180) / Math.PI + 360) % 360;
const turn = (a: number, b: number) => Math.abs(((a - b + 540) % 360) - 180);
/** The face rule of the record a wall with this outward normal falls under (the nearest direction within its spread), or undefined. */
export function faceOf(a: BuildingAppearance, n: XY) {
  const az = azimuth(n);
  return (a.faces ?? []).filter((f) => turn(az, f.azimuth) <= (f.spread ?? 45)).sort((f, g) => turn(az, f.azimuth) - turn(az, g.azimuth))[0];
}

const area2 = (r: XY[]) => r.reduce((s, p, i) => s + p[0] * r[(i + 1) % r.length][1] - r[(i + 1) % r.length][0] * p[1], 0);
function contains(x: number, y: number, ring: XY[]) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
/** Open ring without repeated or (nearly) collinear points. */
function tidy(ring: XY[], tol = 0.05): XY[] {
  let r = ring.filter((p, i) => i === 0 || Math.hypot(p[0] - ring[i - 1][0], p[1] - ring[i - 1][1]) > 0.01);
  if (r.length > 1 && Math.hypot(r[0][0] - r[r.length - 1][0], r[0][1] - r[r.length - 1][1]) < 0.01) r = r.slice(0, -1);
  return r.filter((p, i) => {
    const a = r[(i + r.length - 1) % r.length], b = r[(i + 1) % r.length];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    return len < 1e-9 || Math.abs((b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0])) / len > tol;
  });
}

class Builder {
  readonly mesh: Mesh = { positions: [], normals: [], colors: [] };
  tri(a: number[], b: number[], c: number[], color: RGB) {
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const len = Math.hypot(n[0], n[1], n[2]);
    if (len < 1e-9) return;
    for (const p of [a, b, c]) { this.mesh.positions.push(p[0], p[1], p[2]); this.mesh.normals.push(n[0] / len, n[1] / len, n[2] / len); this.mesh.colors.push(color[0], color[1], color[2]); }
  }
  quad(a: number[], b: number[], c: number[], d: number[], color: RGB) { this.tri(a, b, c, color); this.tri(a, c, d, color); }
  /** Vertical rectangle on a wall: from `s0` to `s1` metres along the edge p→(u), `off` metres out of the wall (n), between two heights. */
  panel(p: XY, u: XY, n: XY, s0: number, s1: number, z0: number, z1: number, off: number, color: RGB) {
    if (s1 - s0 < 0.05 || z1 - z0 < 0.05) return;
    const at = (s: number, z: number) => [p[0] + u[0] * s + n[0] * off, p[1] + u[1] * s + n[1] * off, z];
    this.quad(at(s0, z0), at(s1, z0), at(s1, z1), at(s0, z1), color);
  }
  /** A pier standing out of a wall: its front, its two sides and its top. */
  pier(p: XY, u: XY, n: XY, s0: number, s1: number, z0: number, z1: number, depth: number, color: RGB) {
    if (s1 - s0 < 0.05 || z1 - z0 < 0.05) return;
    const at = (s: number, d: number, z: number) => [p[0] + u[0] * s + n[0] * d, p[1] + u[1] * s + n[1] * d, z];
    this.quad(at(s0, depth, z0), at(s1, depth, z0), at(s1, depth, z1), at(s0, depth, z1), color);
    this.quad(at(s0, 0, z0), at(s0, depth, z0), at(s0, depth, z1), at(s0, 0, z1), color);
    this.quad(at(s1, depth, z0), at(s1, 0, z0), at(s1, 0, z1), at(s1, depth, z1), color);
    this.quad(at(s0, 0, z1), at(s0, depth, z1), at(s1, depth, z1), at(s1, 0, z1), color);
  }
  /** A box on a wall edge: from `s0` to `s1` along it, from `d0` to `d1` out of it (negative: behind it), between two heights; all faces but the back. */
  box(p: XY, u: XY, n: XY, s0: number, s1: number, d0: number, d1: number, z0: number, z1: number, color: RGB) {
    const at = (s: number, d: number, z: number) => [p[0] + u[0] * s + n[0] * d, p[1] + u[1] * s + n[1] * d, z];
    this.quad(at(s0, d1, z0), at(s1, d1, z0), at(s1, d1, z1), at(s0, d1, z1), color);
    this.quad(at(s0, d0, z0), at(s0, d1, z0), at(s0, d1, z1), at(s0, d0, z1), color);
    this.quad(at(s1, d1, z0), at(s1, d0, z0), at(s1, d0, z1), at(s1, d1, z1), color);
    this.quad(at(s0, d0, z0), at(s1, d0, z0), at(s1, d1, z0), at(s0, d1, z0), color);
    this.quad(at(s0, d0, z1), at(s0, d1, z1), at(s1, d1, z1), at(s1, d0, z1), color);
  }
  /** Flat polygon (outer ring + holes) at one height. */
  cap(rings: XY[][], z: number, color: RGB, zAt?: (x: number, y: number) => number) {
    const flat = rings.flatMap((r) => r.flatMap((p) => [p[0], p[1]]));
    const holes: number[] = [];
    rings.slice(0, -1).reduce((n, r) => { holes.push(n + r.length); return n + r.length; }, 0);
    const at = (i: number) => [flat[2 * i], flat[2 * i + 1], zAt ? zAt(flat[2 * i], flat[2 * i + 1]) : z];
    const t = earcut(flat, holes);
    for (let i = 0; i < t.length; i += 3) this.tri(at(t[i]), at(t[i + 1]), at(t[i + 2]), color);
  }
}

/**
 * The storeys a wall shows: [floor, ceiling] pairs between the ground and the top of the walls.
 * From the note's floor heights when given (a floor below `groundM` or with less than 2 m under the wall top is left out);
 * otherwise `count` equal storeys from the ground up.
 */
export function storeys(a: BuildingAppearance, groundM: number, topM: number): [number, number][] {
  const w = a.windows;
  if (!w) return [];
  if (w.floorsM?.length) {
    const f = [...w.floorsM].sort((p, q) => p - q).filter((z) => z > groundM - 1.5 && z < topM - 2);
    // toRoof: the lines of the last storey height go on up to the top of the walls (lines of the cladding, not counted floors)
    if (w.toRoof && f.length >= 2) for (const h = Math.max(f[f.length - 1] - f[f.length - 2], 2.6); f[f.length - 1] + h < topM - 2; ) f.push(f[f.length - 1] + h);
    return f.map((z, i) => [z, i + 1 < f.length ? f[i + 1] : Math.min(topM, z + (i > 0 ? Math.max(f[i] - f[i - 1], 2.6) : 4))]);
  }
  if (!w.count || !(topM - groundM > w.count * 2)) return [];
  const h = (topM - groundM) / w.count;
  return Array.from({ length: w.count }, (_, i) => [groundM + i * h, groundM + (i + 1) * h] as [number, number]);
}

/**
 * Everything drawn on top of the plain block of one building: window panels on the walls, a rim or an upper band,
 * the roof (a coloured cap on a flat roof; slopes from an overhanging eave up to a smaller flat top on a pitched one).
 * `polygons`: the footprint, each polygon as outer ring + holes (rings may be closed). `groundM`: lowest ground at the walls.
 */
export function decorate(polygons: XY[][][], b: { roofM: number; groundM: number; baseM?: number }, a: BuildingAppearance, opts: DecorOptions = {}): Mesh {
  const out = new Builder();
  if (a.wings?.length) { // B12: the main block without the wings, then every wing as a block of its own that runs back to the main wall
    const { wings, ...rest } = a;
    const main = polygonOps('minus', polygons, wings.map((w) => [w.polygon]));
    const add = (m: Mesh) => { for (const k of ['positions', 'normals', 'colors'] as const) for (const v of m[k]) out.mesh[k].push(v); };
    add(decorate(main, b, rest, opts));
    const inMain = (x: number, y: number) => main.some((poly) => contains(x, y, poly[0]) && !poly.slice(1).some((h) => contains(x, y, h)));
    for (const w of wings) add(decorate(polygonOps('both', [[w.polygon]], polygons), b, { ...rest, faces: undefined, roof: { ...(rest.roof ?? { type: 'hipped' }), tiers: undefined, ...w.roof }, order: w.order }, { ...opts, party: inMain, partyBackM: rest.roof?.overhangM ?? 0 }));
    return out.mesh;
  }
  const shed = shedOf(a);
  // P02 a roof in one plane: the storeys are counted up to its highest point, every wall ends at the plane
  const top = shed ? Math.max(...polygons.flatMap((poly) => poly[0].map((p) => shed(p[0], p[1])))) : wallTopM(b.roofM, a);
  const overhang = a.roof?.overhangM ?? 0, order = a.order;
  const dark = (c: RGB): RGB => [c[0] * CLASSICAL.shade, c[1] * CLASSICAL.shade, c[2] * CLASSICAL.shade];
  // Z09: below the top of a plinth there are no windows (the walls there are the podium or the retaining wall the building stands on)
  const levels = storeys(a, b.groundM, top).filter(([z0]) => (a.plinth?.topM === undefined || z0 >= a.plinth.topM - 0.5) && (!order || (z0 >= order.fromM - 0.5 && z0 + 2.6 <= order.toM)));
  const baseStyle = a.windows ? STYLES[a.windows.style] : null;
  const glass = hex(a.windows?.color ?? (a.windows?.style === 'rows' ? WINDOW.frame : WINDOW.glass)); // punched windows read as their light frames
  const wall = hex(wallColor(a));
  const accent = a.windows?.accent ? hex(a.windows.accent) : null;
  const infill = hex(WINDOW.infill);
  const neighbour = opts.neighbourTop ?? (() => -Infinity);
  // a colonnade stands on the longest wall of its face only
  const longest = new Map<object, number>();
  for (const poly of polygons) for (const ring of poly.map((r) => tidy(r, 0.02)).filter((r) => r.length >= 3)) {
    const inside = (x: number, y: number) => contains(x, y, poly[0]) && !poly.slice(1).some((h) => contains(x, y, h));
    ring.forEach((p, i) => {
      const q = ring[(i + 1) % ring.length], len = Math.hypot(q[0] - p[0], q[1] - p[1]);
      if (len < 0.9) return;
      let n = [(q[1] - p[1]) / len, -(q[0] - p[0]) / len];
      if (inside((p[0] + q[0]) / 2 + n[0] * 0.05, (p[1] + q[1]) / 2 + n[1] * 0.05)) n = [-n[0], -n[1]];
      const f = faceOf(a, n);
      if (f?.columns && len > (longest.get(f) ?? 0)) longest.set(f, len);
    });
  }
  for (const poly of polygons) {
    const rings = poly.map((r) => tidy(r, 0.02)).filter((r) => r.length >= 3);
    if (!rings.length) continue;
    // B12: under a deep eave the walls stand inside the footprint (edge i of the wall ring belongs to edge i of the footprint)
    const frame = overhang > 0 || opts.party ? eaveFrame(rings[0], overhang, opts, order?.rows) : null;
    const walls = frame ? [frame.wall, ...rings.slice(1)] : rings;
    const inside = (x: number, y: number) => contains(x, y, walls[0]) && !walls.slice(1).some((h) => contains(x, y, h));
    for (const ring of walls) {
      for (let i = 0; i < ring.length; i++) {
        const p = ring[i], q = ring[(i + 1) % ring.length];
        const len = Math.hypot(q[0] - p[0], q[1] - p[1]);
        if (frame && ring === frame.wall && frame.edges[i].party) continue;
        if (len < (frame ? 0.05 : 0.9)) continue;
        const u = [(q[0] - p[0]) / len, (q[1] - p[1]) / len];
        let n = [u[1], -u[0]];
        const mid = [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
        if (inside(mid[0] + n[0] * 0.05, mid[1] + n[1] * 0.05)) n = [-n[0], -n[1]];
        if (opts.cut?.(mid[0], mid[1])) continue;
        const hidden = neighbour(mid[0] + n[0] * 0.4, mid[1] + n[1] * 0.4); // a neighbour stands against this wall up to here
        let clear: [number, number, number] | null = null; // no windows along the wall from, to; from this height up
        let lv = levels; // the storeys this wall shows
        if (shed) { // the wall itself (the plain block is not drawn) up to the roof plane, with a rim; no wall where the next part of the same mass stands
          const zp = shed(p[0], p[1]), zq = shed(q[0], q[1]), edgeTop = Math.min(zp, zq);
          if (hidden > edgeTop - 6) continue;
          const low = Math.min(b.baseM ?? b.groundM - 3, b.groundM) - 0.5, at = (r: XY, z: number, off = 0) => [r[0] + n[0] * off, r[1] + n[1] * off, z];
          out.quad(at(p, low), at(q, low), at(q, zq), at(p, zp), wall);
          out.quad(at(p, zp - 0.9, 0.1), at(q, zq - 0.9, 0.1), at(q, zq + 0.3, 0.1), at(p, zp + 0.3, 0.1), hex(a.roof?.rim ?? roofColor(a)));
          lv = levels.filter(([z0]) => z0 + 1.5 < edgeTop - 0.9).map(([z0, z1]) => [z0, Math.min(z1, edgeTop - 0.9)] as [number, number]);
        }
        if (frame) { // the wall itself (the plain block is not drawn), with an open porch behind a row of columns
          const low = Math.min(b.baseM ?? b.groundM - 3, b.groundM) - 0.5;
          const row = order && ring === frame.wall ? order.rows?.find((r) => frame.edges[i].row === r) : undefined;
          const s0 = CLASSICAL.pierM, s1 = len - CLASSICAL.pierM;
          if (!row || s1 - s0 < 2) out.panel(p, u, n, 0, len, low, top, 0, wall);
          else {
            const z0 = order!.fromM, z1 = order!.toM, d = CLASSICAL.porchM, at = (s: number, off: number, z: number) => [p[0] + u[0] * s + n[0] * off, p[1] + u[1] * s + n[1] * off, z];
            out.panel(p, u, n, 0, s0, low, top, 0, wall); out.panel(p, u, n, s1, len, low, top, 0, wall);
            out.panel(p, u, n, s0, s1, low, z0, 0, wall); out.panel(p, u, n, s0, s1, z1, top, 0, wall);
            out.panel(p, u, n, s0, s1, z0, z1, -d, dark(wall));
            out.quad(at(s0, 0, z0), at(s0, -d, z0), at(s0, -d, z1), at(s0, 0, z1), dark(wall)); out.quad(at(s1, -d, z0), at(s1, 0, z0), at(s1, 0, z1), at(s1, -d, z1), dark(wall));
            out.quad(at(s0, -d, z0), at(s1, -d, z0), at(s1, 0, z0), at(s0, 0, z0), wall); out.quad(at(s0, -d, z1), at(s1, -d, z1), at(s1, 0, z1), at(s0, 0, z1), dark(wall));
            const r = (order!.diameterM ?? 1.2) / 2, col = hex(CLASSICAL.column), k = Math.max(2, Math.min(row.count, Math.floor((s1 - s0) / (3 * r))));
            for (let c = 0; c < k; c++) { // round columns (twelve sides) with a square capital, their fronts in the plane of the wall
              const s = s0 + ((c + 0.5) * (s1 - s0)) / k, rim = (j: number, z: number) => at(s + r * Math.cos((j * Math.PI) / 6), -r + r * Math.sin((j * Math.PI) / 6), z);
              for (let j = 0; j < 12; j++) out.quad(rim(j + 1, z0), rim(j, z0), rim(j, z1 - CLASSICAL.capitalM), rim(j + 1, z1 - CLASSICAL.capitalM), col);
              out.box(p, u, n, s - 1.25 * r, s + 1.25 * r, -2.25 * r, 0.05, z1 - CLASSICAL.capitalM, z1, col);
            }
            clear = [s0 - 0.3, s1 + 0.3, z0 - 0.5];
          }
          if (order) { // the entablature and the dark attic strip above it, round the whole block
            const zb = Math.min(order.toM + (order.beamM ?? 2), top);
            out.pier(p, u, n, -0.25, len + 0.25, order.toM, zb, 0.25, hex(CLASSICAL.beam));
            out.panel(p, u, n, 0, len, zb, top, 0.04, hex(CLASSICAL.attic));
          }
          if (len < 0.9) continue;
        }
        const face = faceOf(a, n);
        // this face in another material: one panel over the whole wall, under the windows
        if (face && (face.wall || face.wallColor) && hidden < top - 1) out.panel(p, u, n, 0, len, Math.max(b.groundM - 3, hidden), top, 0.03, hex(face.wallColor ?? WALL_COLORS[face.wall ?? ''] ?? WALL_COLORS.panel));
        if (a.plinth?.topM !== undefined && hidden < a.plinth.topM - 0.5) out.panel(p, u, n, 0, len, Math.max(b.groundM - 3, hidden), Math.min(a.plinth.topM, top), 0.05, hex(a.plinth.color));
        if (a.upper && top > a.upper.fromM && hidden < top - 1) out.panel(p, u, n, 0, len, Math.max(a.upper.fromM, hidden), top, 0.04, hex(a.upper.color));
        // B13 bands between two heights in another material, then colour panels scattered over the cladding (not on a face in its own material)
        for (const band of a.bands ?? []) {
          const z1 = Math.min(band.toM ?? top, top), z0 = Math.max(band.fromM, hidden, b.groundM - 3);
          if ((band.wall || band.wallColor) && z1 - z0 > 0.05) out.panel(p, u, n, 0, len, z0, z1, 0.045, hex(band.wallColor ?? WALL_COLORS[band.wall ?? ''] ?? WALL_COLORS.panel));
        }
        if (a.panels?.colors.length && !(face && (face.wall || face.wallColor))) scatter(out, p, u, n, len, Math.max(a.panels.fromM ?? -Infinity, hidden, b.groundM), top, a.panels.colors.map(hex));
        if (a.roof?.rim && !shed && hidden < top - 1) out.panel(p, u, n, 0, len, top - 1.2, top, 0.1, hex(a.roof.rim));
        if (a.roof?.eaveBandM && hidden < top - 1) out.panel(p, u, n, 0, len, top - a.roof.eaveBandM, top, 0.12, hex(WINDOW.cornice));
        // tall columns with a beam on top, centred on the longest wall of the face; no windows behind them
        if (face?.columns && longest.get(face) === len && levels.length && hidden < levels[0][0]) {
          const k = Math.max(2, Math.min(face.columns, Math.floor((len - 1) / COLONNADE.pitch) + 1));
          const span = (k - 1) * COLONNADE.pitch + COLONNADE.width, s0 = (len - span) / 2;
          const z0 = Math.max(levels[0][0], face.columnsFromM ?? -Infinity), z1 = top - (a.roof?.eaveBandM ?? 0) - 0.2, col = hex(COLONNADE.color);
          out.panel(p, u, n, s0, s0 + span, z0, z1 - COLONNADE.beam, 0.06, hex(COLONNADE.recess));
          for (let c = 0; c < k; c++) out.pier(p, u, n, s0 + c * COLONNADE.pitch, s0 + c * COLONNADE.pitch + COLONNADE.width, z0, z1 - COLONNADE.beam, COLONNADE.depth, col);
          out.pier(p, u, n, s0 - 0.4, s0 + span + 0.4, z1 - COLONNADE.beam, z1, COLONNADE.depth + 0.2, col);
          clear = [s0 - 0.5, s0 + span + 0.5, z0 - 0.5];
        }
        const preset = face?.style === 'none' ? null : face?.style ? STYLES[face.style] : baseStyle;
        const kind = face?.style ?? a.windows?.style, rowKind = kind;
        if (!preset) continue;
        // Z11: the building's own window size (the note), on the walls that show the building's own style
        const own = kind === a.windows?.style ? a.windows : undefined;
        const pane = own?.widthM ?? preset.width, paired = own?.paired === true && kind !== 'bays' && kind !== 'piers';
        const group = paired ? 2 * pane + PAIR_GAP : pane;
        const sillM = own?.sillM ?? preset.sill;
        const style = { width: group, pitch: own?.pitchM ?? (group > preset.width ? Math.max(preset.pitch, group + 0.4) : preset.pitch), sill: sillM, head: own?.heightM !== undefined ? sillM + own.heightM : preset.head, gap: preset.gap };
        /** The glass of the window (or the pair) that starts at `s`. */
        const panes = (s: number, w: number): [number, number][] => (paired && w >= group - 0.01 ? [[s, s + pane], [s + pane + PAIR_GAP, s + w]] : [[s, s + w]]);
        let count = Math.floor((len - 0.6) / style.pitch), width: number = style.width, pitch: number = style.pitch;
        if (count < 1) { count = 1; width = Math.min(width, len - 0.3); pitch = len - 0.6; }
        const start = (len - count * pitch) / 2 + (pitch - width) / 2;
        const behind = (s: number, z = Infinity) => clear !== null && s + width > clear[0] && s < clear[1] && z >= clear[2];
        if (kind === 'archbays') { // P02: stone piers, between them one tall bay under a round arch: per storey a spandrel panel (two colours in turn) and windows, a dark panel in the arch head
          const seen = lv.filter(([z0]) => z0 >= hidden - 0.5);
          if (!seen.length) continue;
          const bayPitch = own?.pitchM ?? preset.pitch, n1 = Math.max(1, Math.floor((len - ARCHBAY.pierW) / bayPitch)), first = (len - n1 * bayPitch - ARCHBAY.pierW) / 2;
          const bayW = bayPitch - ARCHBAY.pierW, z0 = seen[0][0], crown = top - (a.roof?.eaveBandM ?? 0) - 0.5, r = bayW / 2, ry = Math.min(r, ARCHBAY.headM);
          const spring = Math.max(crown - ry, seen[seen.length - 1][0] + 2.2);
          if (first < 0 || crown - z0 < 4 || bayW < 1.5) continue;
          const frameC = hex(ARCHBAY.frame), headC = hex(ARCHBAY.head), alt = hex(ARCHBAY.alt), acc = accent ?? infill;
          for (let c = 0; c <= n1; c++) out.pier(p, u, n, first + c * bayPitch, first + c * bayPitch + ARCHBAY.pierW, z0, crown + 0.3, ARCHBAY.depth, wall);
          out.pier(p, u, n, first, first + n1 * bayPitch + ARCHBAY.pierW, crown + 0.3, Math.min(crown + 1.1, top), ARCHBAY.depth, wall);
          for (let c = 0; c < n1; c++) {
            const s = first + c * bayPitch + ARCHBAY.pierW;
            seen.forEach(([f0, f1], k) => {
              const ceil = k + 1 < seen.length ? f1 : spring, sill = Math.min(f0 + style.sill, ceil - 0.8), head = Math.min(sill + (own?.heightM ?? 1.3), ceil - 0.25);
              out.panel(p, u, n, s, s + bayW, f0, ceil, 0.05, (c + k) % 2 ? alt : acc); // the spandrel panel of this storey
              const m = paired ? 2 : 1, gapW = 0.25, w = Math.min(pane, (bayW - 0.5 - (m - 1) * gapW) / m), w0 = s + (bayW - m * w - (m - 1) * gapW) / 2;
              for (let j = 0; j < m; j++) {
                out.panel(p, u, n, w0 + j * (w + gapW) - 0.08, w0 + j * (w + gapW) + w + 0.08, sill - 0.08, head + 0.08, 0.07, frameC);
                out.panel(p, u, n, w0 + j * (w + gapW), w0 + j * (w + gapW) + w, sill, head, 0.09, glass);
              }
            });
            // the arch head: a dark half ellipse on the spring line; the corners above it are the stone of the piers
            out.panel(p, u, n, s, s + bayW, spring, crown + 0.3, 0.03, wall);
            const at = (t: number) => { const s1 = s + r - r * Math.cos(t); return [p[0] + u[0] * s1 + n[0] * 0.08, p[1] + u[1] * s1 + n[1] * 0.08, spring + (crown - spring) * Math.sin(t)]; };
            const centre = [p[0] + u[0] * (s + r) + n[0] * 0.08, p[1] + u[1] * (s + r) + n[1] * 0.08, spring];
            for (let j = 0; j < 10; j++) out.tri(centre, at((j * Math.PI) / 10), at(((j + 1) * Math.PI) / 10), headC);
          }
          continue;
        }
        if (kind === 'piers') { // straight piers with deep balconies between them, through the storeys that show
          const seen = lv.filter(([z0]) => z0 >= hidden - 0.5);
          if (!seen.length) continue;
          const z0 = seen[0][0], z1 = top - (a.roof?.eaveBandM ?? 0) - 0.1, pierW = pitch - width;
          if (z1 - z0 < 3 || pierW < 0.3) continue;
          const first = (len - count * pitch - pierW) / 2; // piers at both ends
          const rail = accent ?? hex(PIERS.rail);
          for (let c = 0; c <= count; c++) out.pier(p, u, n, first + c * pitch, first + c * pitch + pierW, z0, z1, PIERS.depth, wall);
          out.pier(p, u, n, first, first + count * pitch + pierW, z1 - PIERS.beam, z1, PIERS.depth + 0.05, wall);
          for (let c = 0; c < count; c++) {
            const s = first + c * pitch + pierW;
            out.panel(p, u, n, s, s + width, z0, z1 - PIERS.beam, 0.06, hex(PIERS.recess));
            for (const [f0, f1] of seen) {
              if (f0 + PIERS.railM > z1 - PIERS.beam) continue;
              out.pier(p, u, n, s, s + width, f0 - 0.25, f0 + PIERS.railM, PIERS.railDepth, rail);
              out.panel(p, u, n, s + 0.3, s + width - 0.3, f0 + PIERS.glassFrom, Math.min(f0 + PIERS.glassTo, f1 - 0.4, z1 - PIERS.beam - 0.1), 0.08, glass);
            }
          }
          continue;
        }
        if (kind === 'bays') { // one bay through the storeys that show above a neighbour: glass, a round head, a wall band at each floor
          const seen = lv.filter(([z0]) => z0 >= hidden - 0.5);
          if (!seen.length) continue;
          const r = width / 2, sill = seen[0][0] + style.sill, crown = Math.min(seen[seen.length - 1][1] - style.gap, top - (a.roof?.eaveBandM ?? 0) - 0.5);
          const ry = Math.min(r, Math.max(0, crown - sill - 1)), head = crown - ry;
          for (let c = 0; c < count; c++) {
            const s = start + c * pitch;
            if (behind(s) || head - sill < 0.5) continue;
            out.panel(p, u, n, s, s + width, sill, head, 0.08, glass);
            if (ry > 0.3) {
              const at = (t: number) => { const s1 = s + r - r * Math.cos(t); return [p[0] + u[0] * s1 + n[0] * 0.08, p[1] + u[1] * s1 + n[1] * 0.08, head + ry * Math.sin(t)]; };
              const centre = [p[0] + u[0] * (s + r) + n[0] * 0.08, p[1] + u[1] * (s + r) + n[1] * 0.08, head];
              for (let j = 0; j < 8; j++) out.tri(centre, at((j * Math.PI) / 8), at(((j + 1) * Math.PI) / 8), glass);
            }
            seen.slice(1).forEach(([z0], j) => { if (z0 + 0.3 < head) out.panel(p, u, n, s, s + width, z0 - 0.35, z0 + 0.3, 0.1, accent && j % 2 ? accent : wall); });
          }
          continue;
        }
        lv.forEach(([z0, z1], k) => {
          if (z0 < hidden - 0.5) return;
          const sill = z0 + style.sill, head = Math.min(z0 + style.head, z1 - style.gap);
          // B13: a row that starts inside a band with its own window style (a round head on the top row, dormers in a tiled band)
          const band = (a.bands ?? []).find((d) => d.style && z0 >= d.fromM - 0.3 && z0 < (d.toM ?? Infinity) - 0.3);
          if (band?.style === 'none') return;
          const kind = band?.style ?? rowKind, own = Math.min(band?.widthM ?? width, pitch - 0.2), shift = (width - own) / 2; // the band's own window, centred where the wall's window would be
          // Z11 a ribbon: the light band the windows of a row sit in, along the whole wall
          if (accent && kind === 'bands' && !behind(0, z0)) out.panel(p, u, n, 0.2, len - 0.2, sill - 0.3, head + 0.3, 0.06, accent);
          for (let c = 0; c < count; c++) {
            const s = start + c * pitch;
            if (behind(s, z0)) continue;
            // the panel of the bay: the accent colour and grey in a checker (the real pattern is irregular); it shows under the window and between paired ones
            if (accent && kind === 'arches') out.panel(p, u, n, s, s + width, z0 + 0.05, paired ? head + 0.15 : sill - 0.05, paired ? 0.06 : 0.08, (c + k) % 2 ? infill : accent);
            for (const [s0, s1] of band?.widthM ? [[s + shift, s + shift + own]] : panes(s, width)) {
              out.panel(p, u, n, s0, s1, sill, head, 0.08, glass);
              if (kind !== 'archrows') continue; // every small window ends in a round head (drawn flatter when the storey above is short)
              const r = (s1 - s0) / 2, ry = Math.min(r, z1 - style.gap - head + 0.3);
              if (ry > 0.3) {
                const at = (t: number) => { const q1 = s0 + r - r * Math.cos(t); return [p[0] + u[0] * q1 + n[0] * 0.08, p[1] + u[1] * q1 + n[1] * 0.08, head + ry * Math.sin(t)]; };
                const centre = [p[0] + u[0] * (s0 + r) + n[0] * 0.08, p[1] + u[1] * (s0 + r) + n[1] * 0.08, head];
                for (let j = 0; j < 8; j++) out.tri(centre, at((j * Math.PI) / 8), at(((j + 1) * Math.PI) / 8), glass);
              }
            }
            if (kind === 'arches' && k === lv.length - 1) { // the bay ends in a round head (drawn flatter when the wall above is short)
              const r = width / 2, ry = Math.min(r, top - head - 0.4);
              if (ry > 0.3) {
                const at = (t: number) => { const s1 = s + r - r * Math.cos(t); return [p[0] + u[0] * s1 + n[0] * 0.08, p[1] + u[1] * s1 + n[1] * 0.08, head + ry * Math.sin(t)]; };
                const centre = [p[0] + u[0] * (s + r) + n[0] * 0.08, p[1] + u[1] * (s + r) + n[1] * 0.08, head];
                for (let j = 0; j < 8; j++) out.tri(centre, at((j * Math.PI) / 8), at(((j + 1) * Math.PI) / 8), glass);
              }
            }
          }
        });
      }
    }
    roof(out, rings, top, a, opts, neighbour, frame);
  }
  return out.mesh;
}

/**
 * B13 colour panels on a wall of stacked boxes: rows about 2.6 m high from `z0` to `z1`, in each row panels of uneven width with uneven
 * gaps. The places come from a hash of the wall's position (the same wall always gets the same pattern); nothing is measured.
 */
function scatter(out: Builder, p: XY, u: XY, n: XY, len: number, z0: number, z1: number, colors: RGB[]) {
  if (!(z1 - z0 > 1.5) || len < 2) return;
  const rows = Math.max(1, Math.round((z1 - z0) / 2.6)), h = (z1 - z0) / rows;
  let seed = (Math.round(p[0] * 10) * 73856093) ^ (Math.round(p[1] * 10) * 19349663);
  const rnd = () => { seed = (Math.imul(seed ^ (seed >>> 15), 0x2c1b3c6d) + 0x9e3779b9) | 0; return ((seed >>> 8) & 0xffff) / 0x10000; };
  for (let r = 0; r < rows; r++) {
    for (let s = 0.3 + rnd() * 2; s < len - 1.3; ) {
      const w = Math.min(1.0 + rnd() * 2.4, len - 0.3 - s), tall = rnd() < 0.7;
      if (rnd() < 0.62) out.panel(p, u, n, s, s + w, z0 + r * h + 0.12, z0 + (r + 1) * h - (tall ? 0.12 : h * 0.55), 0.05, colors[Math.floor(rnd() * colors.length) % colors.length]);
      s += w + 0.5 + rnd() * 2.6;
    }
  }
}

/** The ring moved by `d[i]` metres along the outward normal `n[i]` of each edge (negative: inwards); corners stay where the moved edges meet. */
function moved(ring: XY[], n: XY[], d: number[]): XY[] {
  const N = ring.length;
  return ring.map((p, i) => {
    const h = (i + N - 1) % N, det = n[h][0] * n[i][1] - n[h][1] * n[i][0];
    if (Math.abs(det) < 0.2) { const k = (d[h] + d[i]) / 2; return [p[0] + ((n[h][0] + n[i][0]) / 2) * k, p[1] + ((n[h][1] + n[i][1]) / 2) * k]; }
    return [p[0] + (d[h] * n[i][1] - d[i] * n[h][1]) / det, p[1] + (n[h][0] * d[i] - n[i][0] * d[h]) / det];
  });
}
type EaveFrame = { eave: XY[]; wall: XY[]; edges: { party: boolean; cut: boolean; row?: object }[] };
/**
 * B12: the footprint as the line of the eave (counter-clockwise) and the walls `overhang` inside it. An edge on a section cut
 * stays where it is; an edge of a wing against its main block moves `partyBackM` out, to that block's wall, eave and wall alike.
 */
function eaveFrame(ring: XY[], overhang: number, opts: DecorOptions, rows: { at: number[] }[] = []): EaveFrame {
  let outer = tidy(ring, 0.02);
  if (area2(outer) < 0) outer = [...outer].reverse();
  const N = outer.length;
  const n = outer.map((p, i) => { const q = outer[(i + 1) % N], len = Math.hypot(q[0] - p[0], q[1] - p[1]); return [(q[1] - p[1]) / len, -(q[0] - p[0]) / len]; });
  const mid = outer.map((p, i) => [(p[0] + outer[(i + 1) % N][0]) / 2, (p[1] + outer[(i + 1) % N][1]) / 2]);
  const edges: EaveFrame['edges'] = mid.map((m, i) => ({ cut: !!opts.cut?.(m[0], m[1]), party: !!opts.party?.(m[0] + n[i][0] * 0.3, m[1] + n[i][1] * 0.3) }));
  for (const r of rows) { // a row of columns stands on the edge whose middle is nearest to its point (within 4 m)
    const k = mid.reduce((best, m, i) => (Math.hypot(m[0] - r.at[0], m[1] - r.at[1]) < Math.hypot(mid[best][0] - r.at[0], mid[best][1] - r.at[1]) ? i : best), 0);
    if (Math.hypot(mid[k][0] - r.at[0], mid[k][1] - r.at[1]) < 4) edges[k].row = r;
  }
  const back = opts.partyBackM ?? 0;
  return { eave: moved(outer, n, edges.map((e) => (e.party ? back : 0))), wall: moved(outer, n, edges.map((e) => (e.party ? back : e.cut ? 0 : -overhang))), edges };
}

function roof(out: Builder, rings: XY[][], top: number, a: BuildingAppearance, opts: DecorOptions, neighbour: (x: number, y: number) => number, frame: EaveFrame | null = null) {
  if (!a.roof) return;
  const shed = shedOf(a);
  if (shed) { out.cap(rings, 0, hex(roofColor(a)), shed); return; } // P02: the roof is one plane
  if (frame && rise(a) > CLASSICAL.fasciaM) { // B12 a deep eave: soffit with rafters from the walls out to the footprint, a fascia, then the slopes
    const color = hex(roofColor(a)), N = frame.eave.length, zf = top + CLASSICAL.fasciaM, zr = top + rise(a);
    const at = (p: XY, zz: number) => [p[0], p[1], zz];
    const n = frame.eave.map((p, i) => { const q = frame.eave[(i + 1) % N], len = Math.hypot(q[0] - p[0], q[1] - p[1]); return [(q[1] - p[1]) / len, -(q[0] - p[0]) / len]; });
    const open = frame.edges.map((e) => !e.party && !e.cut);
    const area = Math.abs(area2(frame.eave)), perimeter = frame.eave.reduce((s, p, i) => s + Math.hypot(frame.eave[(i + 1) % N][0] - p[0], frame.eave[(i + 1) % N][1] - p[1]), 0);
    let run = Math.min(a.roof.runM ?? rise(a) * 1.9, (0.9 * area) / perimeter), ridge = moved(frame.eave, n, open.map((o) => (o ? -run : 0)));
    for (let k = 0; k < 4 && !(area2(ridge) > 0.02 * area); k++) { run /= 2; ridge = moved(frame.eave, n, open.map((o) => (o ? -run : 0))); }
    const overhang = a.roof.overhangM ?? 0;
    frame.edges.forEach((e, i) => {
      const j = (i + 1) % N, p = frame.eave[i], q = frame.eave[j], len = Math.hypot(q[0] - p[0], q[1] - p[1]), u = [(q[0] - p[0]) / len, (q[1] - p[1]) / len];
      if (open[i]) {
        out.quad(at(frame.wall[i], top), at(frame.wall[j], top), at(q, top), at(p, top), hex(CLASSICAL.soffit));
        out.quad(at(p, top), at(q, top), at(q, zf), at(p, zf), color);
        for (let s = overhang + 0.4; overhang > 0.6 && s < len - overhang - 0.4; s += CLASSICAL.rafterPitch) out.box(p, u, n[i], s, s + 0.24, -overhang, -0.12, top - 0.26, top, hex(CLASSICAL.rafter));
      }
      if (area2(ridge) > 0) out.quad(at(p, open[i] ? zf : top), at(q, open[i] ? zf : top), at(ridge[j], zr), at(ridge[i], zr), open[i] ? color : hex(wallColor(a)));
    });
    if (area2(ridge) > 0) out.cap([ridge], zr, color); else out.cap([frame.eave], zf, color);
    return;
  }
  const color = hex(roofColor(a));
  const h = rise(a);
  let outer = tidy(rings[0]);
  if (h <= 0 || outer.length < 3) { out.cap(rings, top + 0.1, color); return; }
  if (area2(outer) < 0) outer = [...outer].reverse(); // counter-clockwise: the outside is to the right of every edge
  const N = outer.length;
  const perimeter = outer.reduce((s, p, i) => s + Math.hypot(outer[(i + 1) % N][0] - p[0], outer[(i + 1) % N][1] - p[1]), 0);
  const edges = outer.map((p, i) => {
    const q = outer[(i + 1) % N];
    const len = Math.hypot(q[0] - p[0], q[1] - p[1]);
    const n = [(q[1] - p[1]) / len, -(q[0] - p[0]) / len];
    const mid = [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
    // no slope where the wall is a cross-section cut or continues as a higher neighbour (the roof ends in a gable there)
    const open = !opts.cut?.(mid[0], mid[1]) && !(neighbour(mid[0] + n[0] * 0.4, mid[1] + n[1] * 0.4) > top - 0.5);
    return { n, len, open };
  });
  /** The ring moved by `d(edge)` metres along each edge's outward normal (negative: inwards); corners stay where the moved edges meet. */
  const offset = (d: (e: (typeof edges)[number]) => number) => outer.map((p, i) => {
    const e1 = edges[(i + N - 1) % N], e2 = edges[i];
    const d1 = d(e1), d2 = d(e2);
    const det = e1.n[0] * e2.n[1] - e1.n[1] * e2.n[0];
    if (Math.abs(det) < 0.2) { const k = (d1 + d2) / 2; return [p[0] + ((e1.n[0] + e2.n[0]) / 2) * k, p[1] + ((e1.n[1] + e2.n[1]) / 2) * k]; }
    return [p[0] + (d1 * e2.n[1] - d2 * e1.n[1]) / det, p[1] + (e1.n[0] * d2 - e2.n[0] * d1) / det];
  });
  const eaveM = a.roof.eaveM ?? 0.9;
  const eave = offset((e) => (e.open ? eaveM : 0));
  // the run of the slope: as asked, but never more than what leaves a top (about half the width of a long block)
  let run = Math.min(a.roof.runM ?? h * 1.4, (0.9 * Math.abs(area2(outer))) / perimeter);
  let ridge = offset((e) => (e.open ? -run : 0));
  for (let k = 0; k < 3 && !(area2(ridge) > 0.02 * area2(outer)); k++) { run /= 2; ridge = offset((e) => (e.open ? -run : 0)); }
  if (!(area2(ridge) > 0)) { out.cap(rings, top + 0.1, color); return; }
  // Z10: a pitched roof with a rim colour has its eave in that colour (a dark metal mansard has no light cornice)
  const cornice = hex(a.roof.rim ?? WINDOW.cornice), wall = hex(wallColor(a)), dormer = hex(WINDOW.dormer);
  const z = (p: XY, zz: number) => [p[0], p[1], zz];
  if (a.roof.tiers === 2) { // Z09 a double eave: the lower roof up to a low wall band, the smaller upper roof with its own eave above it
    const h1 = h * 0.4, low = offset((e) => (e.open ? -run * 0.45 : 0)), upper = offset((e) => (e.open ? -run * 0.45 + TIERS.eaveM : 0)), z2 = top + h1 + TIERS.bandM;
    if (area2(low) > 0 && area2(upper) > 0) {
      edges.forEach((e, i) => {
        const j = (i + 1) % N;
        if (e.open) {
          out.quad(z(outer[i], top - 0.45), z(outer[j], top - 0.45), z(eave[j], top - 0.45), z(eave[i], top - 0.45), cornice);
          out.quad(z(eave[i], top - 0.45), z(eave[j], top - 0.45), z(eave[j], top), z(eave[i], top), cornice);
        }
        out.quad(z(eave[i], top), z(eave[j], top), z(low[j], top + h1), z(low[i], top + h1), e.open ? color : wall);
        out.quad(z(low[i], top + h1), z(low[j], top + h1), z(low[j], z2), z(low[i], z2), e.open ? hex(TIERS.band) : wall);
        if (e.open) out.quad(z(low[i], z2 - 0.05), z(low[j], z2 - 0.05), z(upper[j], z2 - 0.05), z(upper[i], z2 - 0.05), cornice);
        out.quad(z(upper[i], z2), z(upper[j], z2), z(ridge[j], z2 + h * 0.6), z(ridge[i], z2 + h * 0.6), e.open ? color : wall);
      });
      out.cap([ridge], z2 + h * 0.6, color);
      return;
    }
  }
  edges.forEach((e, i) => {
    const j = (i + 1) % N;
    if (e.open) { // the eave: its underside and a light band along its edge
      out.quad(z(outer[i], top - 0.45), z(outer[j], top - 0.45), z(eave[j], top - 0.45), z(eave[i], top - 0.45), cornice);
      out.quad(z(eave[i], top - 0.45), z(eave[j], top - 0.45), z(eave[j], top), z(eave[i], top), cornice);
    }
    out.quad(z(eave[i], top), z(eave[j], top), z(ridge[j], top + h), z(ridge[i], top + h), e.open ? color : wall);
    if (!e.open || !a.roof!.dormers || e.len < 6) return;
    const count = Math.floor(e.len / 5);
    for (let c = 0; c < count; c++) { // dormers: light panels lying on the slope
      const lerp = (s: number, t: number) => {
        const lo = [eave[i][0] + (eave[j][0] - eave[i][0]) * s, eave[i][1] + (eave[j][1] - eave[i][1]) * s];
        const hi = [ridge[i][0] + (ridge[j][0] - ridge[i][0]) * s, ridge[i][1] + (ridge[j][1] - ridge[i][1]) * s];
        return [lo[0] + (hi[0] - lo[0]) * t + e.n[0] * 0.1, lo[1] + (hi[1] - lo[1]) * t + e.n[1] * 0.1, top + h * t + 0.12];
      };
      const s0 = (c + 0.5) / count - 0.55 / e.len, s1 = (c + 0.5) / count + 0.55 / e.len;
      out.quad(lerp(s0, 0.3), lerp(s1, 0.3), lerp(s1, 0.6), lerp(s0, 0.6), dormer);
    }
  });
  out.cap([ridge], top + h, color);
}
