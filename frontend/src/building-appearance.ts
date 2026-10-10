// How a building looks beyond its plain block (F07): wall colour, window rows per storey, a pitched roof with an
// eave. The record comes from the building notes through the scene API (SceneBuilding.appearance); nothing here is
// measured from photos, the shapes are schematic (one window size per style, square panels, a roof inset by a fixed run).
// Pure geometry in EPSG:5186 metres + MSL heights (tested in test/building-appearance.test.ts); campus-map.ts draws it.
import earcut from 'earcut';
import type { BuildingAppearance } from './api';

export type XY = number[];
/** Triangles, three vertices each: positions x, y, z / unit normals / colours r, g, b (0-255). */
export type Mesh = { positions: number[]; normals: number[]; colors: number[] };
export type DecorOptions = {
  /** Top (MSL) of another building standing at this point, or -Infinity: a wall behind it gets no windows below that, and no roof slope. */
  neighbourTop?: (x: number, y: number) => number;
  /** true: this point lies on a cross-section cut (the face there is not a wall). */
  cut?: (x: number, y: number) => boolean;
};

type RGB = [number, number, number];
const hex = (css: string): RGB => [1, 3, 5].map((i) => parseInt(css.slice(i, i + 2), 16)) as RGB;

/** Wall and roof colours per material word of the notes; `color` in the record replaces them. */
export const WALL_COLORS: Record<string, string> = {
  brick: '#9c4a3c', glass: '#4f8fa8', stone: '#d9d2c2', concrete: '#a9a8a2', ivy: '#4d6b3a', panel: '#c9c3b4', metal: '#5b6068', white: '#ece9e1',
};
export const ROOF_COLORS: Record<string, string> = { tile: '#4a4d52', concrete: '#b5b3ac', glass: '#3f7890', green: '#5f8a5a', metal: '#4d5258', court: '#4f9a63' };
const WINDOW = { glass: '#9fc4d6', frame: '#e8ebe6', dormer: '#d5d9dc', cornice: '#d8d4c8' };

export const wallColor = (a: BuildingAppearance) => a.wallColor ?? WALL_COLORS[a.wall] ?? WALL_COLORS.panel;
const roofColor = (a: BuildingAppearance) => a.roof?.color ?? ROOF_COLORS[a.roof?.material ?? ''] ?? ROOF_COLORS.concrete;
const rise = (a: BuildingAppearance | null | undefined) => (a?.roof?.type === 'hipped' ? a.roof.riseM ?? 3 : 0);

/** Top of the walls: a pitched roof takes its rise half below and half above the stored (flat) roof height. */
export const wallTopM = (roofM: number, a: BuildingAppearance | null | undefined) => roofM - rise(a) / 2;

/** Window layout per style: spacing and width along the wall, sill and head above the floor (head also limited by the storey). */
const STYLES = {
  rows: { pitch: 3.2, width: 1.5, sill: 0.95, head: 2.45, gap: 0.5 },
  bands: { pitch: 6, width: 5.5, sill: 1.0, head: 2.3, gap: 0.6 },
  curtain: { pitch: 1.8, width: 1.66, sill: 0.14, head: 99, gap: 0.14 },
  arches: { pitch: 4.2, width: 3.0, sill: 1.0, head: 2.6, gap: 0.5 },
} as const;

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
  /** Flat polygon (outer ring + holes) at one height. */
  cap(rings: XY[][], z: number, color: RGB) {
    const flat = rings.flatMap((r) => r.flatMap((p) => [p[0], p[1]]));
    const holes: number[] = [];
    rings.slice(0, -1).reduce((n, r) => { holes.push(n + r.length); return n + r.length; }, 0);
    const at = (i: number) => [flat[2 * i], flat[2 * i + 1], z];
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
export function decorate(polygons: XY[][][], b: { roofM: number; groundM: number }, a: BuildingAppearance, opts: DecorOptions = {}): Mesh {
  const out = new Builder();
  const top = wallTopM(b.roofM, a);
  const levels = storeys(a, b.groundM, top);
  const style = a.windows ? STYLES[a.windows.style] : null;
  const glass = hex(a.windows?.color ?? WINDOW.glass);
  const accent = a.windows?.accent ? hex(a.windows.accent) : null;
  const neighbour = opts.neighbourTop ?? (() => -Infinity);
  for (const poly of polygons) {
    const rings = poly.map((r) => tidy(r, 0.02)).filter((r) => r.length >= 3);
    if (!rings.length) continue;
    const inside = (x: number, y: number) => contains(x, y, rings[0]) && !rings.slice(1).some((h) => contains(x, y, h));
    for (const ring of rings) {
      for (let i = 0; i < ring.length; i++) {
        const p = ring[i], q = ring[(i + 1) % ring.length];
        const len = Math.hypot(q[0] - p[0], q[1] - p[1]);
        if (len < 0.9) continue;
        const u = [(q[0] - p[0]) / len, (q[1] - p[1]) / len];
        let n = [u[1], -u[0]];
        const mid = [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
        if (inside(mid[0] + n[0] * 0.05, mid[1] + n[1] * 0.05)) n = [-n[0], -n[1]];
        if (opts.cut?.(mid[0], mid[1])) continue;
        const hidden = neighbour(mid[0] + n[0] * 0.4, mid[1] + n[1] * 0.4); // a neighbour stands against this wall up to here
        if (a.upper && top > a.upper.fromM && hidden < top - 1) out.panel(p, u, n, 0, len, Math.max(a.upper.fromM, hidden), top, 0.04, hex(a.upper.color));
        if (a.roof?.rim && hidden < top - 1) out.panel(p, u, n, 0, len, top - 1.2, top, 0.1, hex(a.roof.rim));
        if (!style) continue;
        let count = Math.floor((len - 0.6) / style.pitch), width: number = style.width, pitch: number = style.pitch;
        if (count < 1) { count = 1; width = Math.min(width, len - 0.3); pitch = len - 0.6; }
        const start = (len - count * pitch) / 2 + (pitch - width) / 2;
        levels.forEach(([z0, z1], k) => {
          if (z0 < hidden - 0.5) return;
          const sill = z0 + style.sill, head = Math.min(z0 + style.head, z1 - style.gap);
          for (let c = 0; c < count; c++) {
            const s = start + c * pitch;
            out.panel(p, u, n, s, s + width, sill, head, 0.08, glass);
            if (accent && a.windows!.style === 'arches') out.panel(p, u, n, s, s + width, z0 + 0.05, sill - 0.05, 0.08, accent);
            if (a.windows!.style === 'arches' && k === levels.length - 1) { // the bay ends in a round head (drawn flatter when the wall above is short)
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
    roof(out, rings, top, a, opts, neighbour);
  }
  return out.mesh;
}

function roof(out: Builder, rings: XY[][], top: number, a: BuildingAppearance, opts: DecorOptions, neighbour: (x: number, y: number) => number) {
  if (!a.roof) return;
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
  const eaveM = a.roof.eaveM ?? 0.6;
  const eave = offset((e) => (e.open ? eaveM : 0));
  // the run of the slope: as asked, but never more than what leaves a top (about half the width of a long block)
  let run = Math.min(a.roof.runM ?? h * 1.4, (0.9 * Math.abs(area2(outer))) / perimeter);
  let ridge = offset((e) => (e.open ? -run : 0));
  for (let k = 0; k < 3 && !(area2(ridge) > 0.02 * area2(outer)); k++) { run /= 2; ridge = offset((e) => (e.open ? -run : 0)); }
  if (!(area2(ridge) > 0)) { out.cap(rings, top + 0.1, color); return; }
  const cornice = hex(WINDOW.cornice), wall = hex(wallColor(a)), dormer = hex(WINDOW.dormer);
  const z = (p: XY, zz: number) => [p[0], p[1], zz];
  edges.forEach((e, i) => {
    const j = (i + 1) % N;
    if (e.open) out.quad(z(outer[i], top), z(outer[j], top), z(eave[j], top), z(eave[i], top), cornice); // soffit of the eave
    out.quad(z(eave[i], top), z(eave[j], top), z(ridge[j], top + h), z(ridge[i], top + h), e.open ? color : wall);
    if (!e.open || !a.roof!.dormers || e.len < 6) return;
    const count = Math.floor(e.len / 5);
    for (let c = 0; c < count; c++) { // dormers: light panels lying on the slope
      const lerp = (s: number, t: number) => {
        const lo = [eave[i][0] + (eave[j][0] - eave[i][0]) * s, eave[i][1] + (eave[j][1] - eave[i][1]) * s];
        const hi = [ridge[i][0] + (ridge[j][0] - ridge[i][0]) * s, ridge[i][1] + (ridge[j][1] - ridge[i][1]) * s];
        return [lo[0] + (hi[0] - lo[0]) * t + e.n[0] * 0.1, lo[1] + (hi[1] - lo[1]) * t + e.n[1] * 0.1, top + h * t + 0.12];
      };
      const s0 = (c + 0.5) / count - 0.7 / e.len, s1 = (c + 0.5) / count + 0.7 / e.len;
      out.quad(lerp(s0, 0.3), lerp(s1, 0.3), lerp(s1, 0.7), lerp(s0, 0.7), dormer);
    }
  });
  out.cap([ridge], top + h, color);
}
