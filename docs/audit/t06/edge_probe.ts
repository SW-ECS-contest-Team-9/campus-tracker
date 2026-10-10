/** T06: what lies outside each plateau edge (to decide where a blend would smear a wall). Read-only, test DB only.
 *   npx tsx ../docs/audit/t06/edge_probe.ts BASE recipe.json
 * Prints, per 10 m of polygon edge: ground 2 / 5 m outside after the sample step minus the plateau height, and the nearest building. */
import fs from 'node:fs';
import path from 'node:path';
import { env } from '../../../backend/src/config/env.js';
import { pool } from '../../../backend/src/config/database.js';
import { bilinear } from '../../../backend/src/geo/dem.js';
import { terrain } from '../../../backend/src/geo/terrain.js';
import { applyRecipe, parsePolygons, parseRecipe, recipeFiles } from '../../../backend/src/geo/terrain-recipe.js';
const readJson = (f: string) => JSON.parse(fs.readFileSync(f, 'utf8'));
async function main() {
  const [base, file] = process.argv.slice(2);
  if (new URL(env.DATABASE_URL).port !== '5544') throw new Error('Refused: not the T05 test database');
  const recipe = parseRecipe(readJson(file));
  const inputs = Object.fromEntries(recipeFiles(recipe).map((f) => [f, readJson(path.resolve(path.dirname(file), f))]));
  const ctx = (await terrain.context(base))!;
  const g = ctx.grid;
  const h = applyRecipe(g, ctx.heights, { ...recipe, steps: recipe.steps.filter((s) => s.type === 'local-samples') }, inputs, []).heights;
  const step = recipe.steps.find((s) => s.type === 'plateau') as any;
  const r1 = (v: number) => Math.round(v * 10) / 10;
  for (const p of parsePolygons(inputs[step.file], true)) {
    const ring = p.rings[0]; let area = 0;
    for (let i = 0; i + 1 < ring.length; i++) area += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
    const sign = area > 0 ? 1 : -1; // outward normal = right of travel for a counter-clockwise ring
    console.log(`== ${p.name} ${p.heightM} m`);
    let s = 0;
    for (let i = 0; i + 1 < ring.length; i++) {
      const [ax, ay] = ring[i], [bx, by] = ring[i + 1]; const len = Math.hypot(bx - ax, by - ay);
      const nx = sign * (by - ay) / len, ny = -sign * (bx - ax) / len;
      for (let t = Math.min(5, len / 2); t < len; t += 10) {
        const x = ax + (bx - ax) * t / len, y = ay + (by - ay) * t / len;
        const at = (d: number) => r1(bilinear(g, h, x + nx * d, y + ny * d)! - p.heightM);
        const b = terrain.buildingAt(ctx, x + nx * 2, y + ny * 2);
        const b5 = terrain.buildingAt(ctx, x + nx * 5, y + ny * 5);
        console.log(`s=${Math.round(s + t)} (${r1(x)}, ${r1(y)}) out2=${at(2)} out5=${at(5)} out8=${at(8)} in2=${at(-2)} bld2=${b.building?.name ?? '-'}(${r1(b.distance)}) bld5=${b5.building?.name ?? '-'}(${r1(b5.distance)})`);
      }
      s += len;
    }
  }
}
main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => pool.end());
