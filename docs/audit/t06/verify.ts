/** T06: numbers for a terrain recipe candidate. Reads the LOCAL TEST DB only (refuses anything but 127.0.0.1:5544); writes nothing.
 * Run from backend/ with DATABASE_URL of the test container:
 *   npx tsx ../docs/audit/t06/verify.ts BASE_VERSION recipe.json OUT.json [--version=STORED_ID] [--compare=VERSION_ID]
 * The recipe is always re-run in memory. --version checks that the stored grid equals the re-run. --compare = the grid to
 * measure the change against (default: the base). Roads are read live (active rows) for the stored-height check.
 */
import fs from 'node:fs';
import path from 'node:path';
import { env } from '../../../backend/src/config/env.js';
import { pool } from '../../../backend/src/config/database.js';
import { bilinear, rasterizePolygon, type Grid } from '../../../backend/src/geo/dem.js';
import { terrain } from '../../../backend/src/geo/terrain.js';
import { CORRIDOR_DEFAULTS, polygonsMask } from '../../../backend/src/geo/terrain-corridor.js';
import { changeStats } from '../../../backend/src/geo/terrain-local-samples.js';
import { applyRecipe, parseCorridors, parsePolygons, parseRecipe, recipeFiles, recipeId, PLATEAU_EDGE_DEFAULTS, type Recipe } from '../../../backend/src/geo/terrain-recipe.js';
import { outlineSamples } from '../../../backend/src/modules/scene/scene-heights.js';

type XY = [number, number];
const r2 = (v: number) => Math.round(v * 100) / 100;
const pct = (v: number[], p: number) => { const s = [...v].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.round(p * (s.length - 1)))] : NaN; };
const readJson = (f: string) => JSON.parse(fs.readFileSync(f, 'utf8').replace(/^﻿/, ''));
const inRing = (x: number, y: number, ring: XY[]) => { let c = false; for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) if ((ring[i][1] > y) !== (ring[j][1] > y) && x < ((ring[j][0] - ring[i][0]) * (y - ring[i][1])) / (ring[j][1] - ring[i][1]) + ring[i][0]) c = !c; return c; };
const segDist = (x: number, y: number, a: number[], b: number[]) => { const l2 = (b[0] - a[0]) ** 2 + (b[1] - a[1]) ** 2; const t = l2 ? Math.max(0, Math.min(1, ((x - a[0]) * (b[0] - a[0]) + (y - a[1]) * (b[1] - a[1])) / l2)) : 0; return Math.hypot(x - a[0] - t * (b[0] - a[0]), y - a[1] - t * (b[1] - a[1])); };
const lineDist = (x: number, y: number, pts: number[][]) => { let d = Infinity; for (let k = 0; k + 1 < pts.length; k++) d = Math.min(d, segDist(x, y, pts[k], pts[k + 1])); return d; };
const ringDist = (x: number, y: number, ring: XY[]) => lineDist(x, y, ring);
/** points every stepM along a polyline with z, the unit normal and the chainage */
function along(pts: number[][], stepM: number) {
  const out: { x: number; y: number; z: number; nx: number; ny: number; s: number }[] = [];
  let s0 = 0;
  for (let k = 0; k + 1 < pts.length; k++) {
    const [ax, ay, az] = pts[k], [bx, by, bz] = pts[k + 1];
    const len = Math.hypot(bx - ax, by - ay);
    if (len < 1e-6) continue;
    for (let s = Math.ceil(s0 / stepM) * stepM; s <= s0 + len; s += stepM) {
      const t = (s - s0) / len;
      out.push({ x: ax + t * (bx - ax), y: ay + t * (by - ay), z: az + t * (bz - az), nx: -(by - ay) / len, ny: (bx - ax) / len, s });
    }
    s0 += len;
  }
  return out;
}

async function main() {
  const argv = process.argv.slice(2), flags = argv.filter((a) => a.startsWith('--'));
  const [baseVersion, recipeFile, outFile] = argv.filter((a) => !a.startsWith('--'));
  const flag = (name: string) => flags.find((f) => f.startsWith(`--${name}=`))?.slice(name.length + 3);
  const url = new URL(env.DATABASE_URL);
  if (!['127.0.0.1', 'localhost'].includes(url.hostname) || url.port !== '5544') throw new Error('Refused: not the T05 test database (127.0.0.1:5544)');
  if (!baseVersion || !recipeFile || !outFile) throw new Error('Usage: verify.ts BASE_VERSION recipe.json OUT.json [--version=ID] [--compare=ID]');
  const recipe: Recipe = parseRecipe(readJson(recipeFile));
  const inputs = Object.fromEntries(recipeFiles(recipe).map((f) => [f, readJson(path.resolve(path.dirname(recipeFile), f))]));
  const ctx = await terrain.context(baseVersion);
  if (!ctx) throw new Error('Base terrain does not exist');
  const g: Grid = ctx.grid, n = g.width * g.height;
  const footprints = ctx.buildings.flatMap((b) => b.polygons) as XY[][][];
  const run = applyRecipe(g, ctx.heights, recipe, inputs, footprints);
  const h = run.heights;
  const id = recipeId(baseVersion, recipe, inputs, footprints);
  const result: any = { at: new Date().toISOString(), baseVersion, recipe: path.basename(recipeFile), id, steps: run.steps };

  const stored = flag('version') ? await terrain.context(flag('version')!) : null;
  if (flag('version')) {
    if (!stored) throw new Error('Stored version does not exist');
    let differ = 0;
    for (let i = 0; i < n; i++) if (stored.heights[i] !== h[i]) differ++;
    result.storedVersion = { id: flag('version'), idMatchesRecipe: flag('version') === id, cellsDifferentFromRerun: differ };
  }
  const cmp = flag('compare') ? await terrain.context(flag('compare')!) : ctx;
  if (!cmp) throw new Error('Compare version does not exist');
  result.changeVsBase = changeStats(g, ctx.heights, h);
  result.changeVsCompare = { version: cmp.versionId, ...changeStats(g, cmp.heights, h) };

  const cx = (i: number) => g.originX + ((i % g.width) + 0.5) * g.resolution, cy = (i: number) => g.originY + (Math.floor(i / g.width) + 0.5) * g.resolution;
  const building = polygonsMask(g, footprints);
  const nearBuilding = (x: number, y: number, d: number) => footprints.some((poly) => inRing(x, y, poly[0]) || ringDist(x, y, poly[0]) <= d);
  const plateauStep = recipe.steps.find((s) => s.type === 'plateau') as any;
  const corridorStep = recipe.steps.find((s) => s.type === 'corridor') as any;
  const plateaus = plateauStep ? parsePolygons(inputs[plateauStep.file], true) : [];
  const lines = corridorStep ? parseCorridors(inputs[corridorStep.file], corridorStep.lines) : [];
  const margin = plateauStep?.marginM ?? PLATEAU_EDGE_DEFAULTS.marginM, pBlend = plateauStep?.blendM ?? PLATEAU_EDGE_DEFAULTS.blendM;
  const shoulder = corridorStep?.shoulderM ?? CORRIDOR_DEFAULTS.shoulderM, cBlend = corridorStep?.blendM ?? CORRIDOR_DEFAULTS.blendM;

  // 1) flat areas: cell centres, bilinear samples on a 0.5 m lattice inside, and the polygon edge
  result.plateaus = plateaus.map((p) => {
    const ring = p.rings[0] as XY[];
    const mask = rasterizePolygon(g, p.rings, 0);
    let cells = 0, cellsKept = 0, maxCell = 0;
    for (let i = 0; i < n; i++) if (mask[i]) { cells++; if (building[i]) cellsKept++; else maxCell = Math.max(maxCell, Math.abs(h[i] - p.heightM)); }
    const xs = ring.map((q) => q[0]), ys = ring.map((q) => q[1]);
    const dev: number[] = [], devOld: number[] = [];
    for (let y = Math.min(...ys); y <= Math.max(...ys); y += 0.5) for (let x = Math.min(...xs); x <= Math.max(...xs); x += 0.5) {
      if (!inRing(x, y, ring)) continue;
      dev.push(bilinear(g, h, x, y)! - p.heightM); devOld.push(bilinear(g, cmp.heights, x, y)! - p.heightM);
    }
    const edge = along([...ring.map((q) => [q[0], q[1], 0]), [ring[0][0], ring[0][1], 0]], 0.5);
    const hidden = (hh: Float32Array, lift: number) => edge.filter((e) => bilinear(g, hh, e.x, e.y)! - p.heightM > lift);
    const hid = hidden(h, 0.05);
    const st = (v: number[]) => ({ n: v.length, min: r2(Math.min(...v)), max: r2(Math.max(...v)), p95Abs: r2(pct(v.map(Math.abs), 0.95)), over5cm: v.filter((d) => Math.abs(d) > 0.05).length, over5cmShare: r2(v.filter((d) => Math.abs(d) > 0.05).length / v.length) });
    return { name: p.name, heightM: p.heightM, cells, cellsInBuildingFootprint: cellsKept, maxAbsAtCellCentresM: r2(maxCell),
      bilinearInside: st(dev), bilinearInsideBefore: st(devOld),
      edge: { samples: edge.length, terrainAboveFloorBy5cm: hid.length, share: r2(hid.length / edge.length), ofWhichWithin3mOfBuilding: hid.filter((e) => nearBuilding(e.x, e.y, 3)).length,
        maxAboveM: r2(Math.max(0, ...edge.map((e) => bilinear(g, h, e.x, e.y)! - p.heightM))),
        before: { terrainAboveFloorBy5cm: hidden(cmp.heights, 0.05).length, share: r2(hidden(cmp.heights, 0.05).length / edge.length) },
        where: hid.filter((_, k) => k % 8 === 0).map((e) => [r2(e.x), r2(e.y), r2(bilinear(g, h, e.x, e.y)! - p.heightM)]) } };
  });

  // 2) roads: terrain minus profile height along each corridor line (centre and across the carriageway), outside building footprints
  const roadStats = (name: string, pts: number[][], half: number, hh: Float32Array) => {
    const centre: number[] = [], across: number[] = []; let worst: any = null;
    for (const p of along(pts, 1)) for (const o of [0, -0.8, 0.8, -1, 1]) {
      const x = p.x + p.nx * o * half, y = p.y + p.ny * o * half;
      if (footprints.some((poly) => inRing(x, y, poly[0]))) continue;
      const d = bilinear(g, hh, x, y)! - p.z;
      (o === 0 ? centre : across).push(d);
      if (!worst || Math.abs(d) > Math.abs(worst[3])) worst = [r2(p.s), o, [r2(x), r2(y)], r2(d)];
    }
    const st = (v: number[]) => ({ n: v.length, maxAbs: r2(Math.max(0, ...v.map(Math.abs))), p95Abs: r2(pct(v.map(Math.abs), 0.95)), median: r2(pct(v, 0.5)) });
    return { name, halfWidthM: half, centre: st(centre), fullWidth: st([...centre, ...across]), worst };
  };
  result.corridorLines = lines.map((l) => ({ ...roadStats(l.name, l.points, l.halfWidthM, h), before: (({ centre, fullWidth }) => ({ centre, fullWidth }))(roadStats(l.name, l.points, l.halfWidthM, cmp.heights)) }));
  // the same against the heights stored in the database now
  const { rows: roads } = await pool.query<{ id: string; name: string | null; cls: string; structure: string; w: number | null; bld: string | null; lvl: string | null; c: number[][] }>(
    `SELECT id, name, road_class cls, structure, width_m w, building_id bld, level_id lvl, ST_AsGeoJSON(geom)::json->'coordinates' c FROM mobility.road_segments WHERE status IN ('DRAFT','APPROVED') ORDER BY id`);
  const onLine = (r: { c: number[][] }) => lines.find((l) => r.c.every((p) => lineDist(p[0], p[1], l.points) < 0.6));
  result.storedRoads = roads.filter((r) => onLine(r)).map((r) => ({ id: r.id.slice(0, 8), line: onLine(r)!.name, widthM: r.w, ...roadStats(r.name ?? '', r.c, (r.w ?? 6) / 2, h) }));
  // every outdoor surface road: stored height minus terrain at the vertices and every metre (rendering guidance)
  result.outdoorRoads = roads.filter((r) => !r.bld && !r.lvl && !['tunnel', 'underground', 'elevator'].includes(r.structure)).map((r) => {
    const d = along(r.c, 1).filter((p) => !footprints.some((poly) => inRing(p.x, p.y, poly[0]))).map((p) => p.z - bilinear(g, h, p.x, p.y)!);
    return { id: r.id.slice(0, 8), name: r.name, cls: r.cls, structure: r.structure, n: d.length, roadMinusTerrain: d.length ? [r2(Math.min(...d)), r2(pct(d, 0.5)), r2(Math.max(...d))] : null };
  });

  // 3) spill: cells changed by the plateau and corridor steps and how far they lie from the shapes
  const afterSamples = applyRecipe(g, ctx.heights, { ...recipe, steps: recipe.steps.filter((s) => s.type === 'local-samples') }, inputs, footprints).heights;
  let shaped = 0, beyond = 0, far = 0, inBuilding = 0;
  for (let i = 0; i < n; i++) {
    if (h[i] !== afterSamples[i]) {
      shaped++;
      if (building[i]) inBuilding++;
      const x = cx(i), y = cy(i);
      const dP = Math.min(Infinity, ...plateaus.map((p) => (inRing(x, y, p.rings[0] as XY[]) ? 0 : ringDist(x, y, p.rings[0] as XY[])) - margin - pBlend));
      const dC = Math.min(Infinity, ...lines.map((l) => lineDist(x, y, l.points) - l.halfWidthM - shoulder - cBlend));
      if (Math.min(dP, dC) > 0) beyond++;
      far = Math.max(far, Math.min(dP, dC));
    }
  }
  result.spill = { cellsChangedByPlateauAndCorridorSteps: shaped, beyondBlendDistance: beyond, farthestBeyondM: r2(Math.max(0, far)), changedInsideBuildingFootprints: inBuilding };

  // 4) steep cells (> 45 degrees) that are new against the compare grid, with what is next to them
  const steep = (hh: Float32Array) => { const m = new Uint8Array(n); for (let iy = 0; iy < g.height; iy++) for (let ix = 0; ix < g.width; ix++) {
    const x0 = hh[iy * g.width + Math.max(0, ix - 1)], x1 = hh[iy * g.width + Math.min(g.width - 1, ix + 1)], y0 = hh[Math.max(0, iy - 1) * g.width + ix], y1 = hh[Math.min(g.height - 1, iy + 1) * g.width + ix];
    if (Math.hypot((x1 - x0) / (2 * g.resolution), (y1 - y0) / (2 * g.resolution)) > 1) m[iy * g.width + ix] = 1; } return m; };
  const sNew = steep(h), sCmp = steep(cmp.heights), sBase = steep(ctx.heights);
  const near = (m: Uint8Array, i: number, cellsR: number) => { const ix = i % g.width, iy = Math.floor(i / g.width); for (let dy = -cellsR; dy <= cellsR; dy++) for (let dx = -cellsR; dx <= cellsR; dx++) { const j = (iy + dy) * g.width + ix + dx; if (j >= 0 && j < n && m[j]) return true; } return false; };
  const created: any[] = []; let gone = 0;
  for (let i = 0; i < n; i++) {
    if (sCmp[i] && !sNew[i]) gone++;
    if (!sNew[i] || sCmp[i]) continue;
    const x = cx(i), y = cy(i);
    const feature = [...plateaus.map((p) => ({ name: p.name, d: inRing(x, y, p.rings[0] as XY[]) ? 0 : ringDist(x, y, p.rings[0] as XY[]) })), ...lines.map((l) => ({ name: l.name, d: lineDist(x, y, l.points) }))].sort((a, b) => a.d - b.d)[0];
    created.push({ xy: [x, y], near: feature?.name, distM: r2(feature?.d ?? NaN), kind: nearBuilding(x, y, 3) ? 'building wall within 3 m' : near(sBase, i, 2) || near(sCmp, i, 2) ? 'bank already steep within 4 m' : 'new' });
  }
  const tally = (key: (c: any) => string) => created.reduce((m: Record<string, number>, c) => ({ ...m, [key(c)]: (m[key(c)] ?? 0) + 1 }), {});
  result.steep = { before: sCmp.reduce((a, b) => a + b, 0), after: sNew.reduce((a, b) => a + b, 0), created: created.length, removed: gone, createdByKind: tally((c) => c.kind), createdByFeature: tally((c) => `${c.near} / ${c.kind}`), createdNew: created.filter((c) => c.kind === 'new') };

  // 5) ground under building outlines (scene:import takes base = lowest outline sample - 1 m)
  result.buildings = ctx.buildings.map((b) => {
    const pts = outlineSamples(b.polygons as any);
    const a = pts.map(([x, y]) => bilinear(g, cmp.heights, x, y)!), c = pts.map(([x, y]) => bilinear(g, h, x, y)!);
    const d = c.map((v, k) => v - a[k]);
    return { id: b.buildingId, name: b.name, outlinePoints: pts.length, minBefore: r2(Math.min(...a)), minAfter: r2(Math.min(...c)), minChange: r2(Math.min(...c) - Math.min(...a)), maxBefore: r2(Math.max(...a)), maxAfter: r2(Math.max(...c)),
      medianChange: r2(pct(c, 0.5) - pct(a, 0.5)), pointsChangedOver0_3: d.filter((v) => Math.abs(v) > 0.3).length, changeRange: [r2(Math.min(...d)), r2(Math.max(...d))] };
  });

  fs.writeFileSync(outFile, JSON.stringify(result, null, 1));
  const { steps: _s, ...brief } = result;
  console.log(JSON.stringify({ ...brief, outdoorRoads: undefined, plateaus: result.plateaus.map((p: any) => ({ ...p, edge: { ...p.edge, where: undefined } })), steep: { ...result.steep, createdNew: result.steep.createdNew.length } }, null, 1));
}
main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => pool.end());
