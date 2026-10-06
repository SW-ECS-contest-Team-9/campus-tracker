/**
 * Routes of the mobility map (docs/MOBILITY_MAP_PLAN.md 4.7–4.10): create/update a route, find its passes,
 * build the canonical path + corridor, validate (leave one pass out). Prints aggregates only (no coordinates lists).
 *
 *   npm run routes:build -- --name="북악관 진입로" --a=-83,114 --b=-55,121 --radius=8 --detect --build --validate
 *   npm run routes:build -- --name="북악관 진입로" --build --validate          (existing route)
 *   npm run routes:build -- --list
 * --a / --b: campus frame "x,y" (m) or "lat,lon" with --wgs84. --sessions=<id|prefix,...> limits pass detection.
 */
import { parseArgs } from 'node:util';
import { pool } from '../src/config/database.js';
import { pathfusionService } from '../src/modules/pathfusion/pathfusion.service.js';

const { values: args } = parseArgs({
  options: {
    name: { type: 'string' }, a: { type: 'string' }, b: { type: 'string' }, wgs84: { type: 'boolean', default: false },
    radius: { type: 'string' }, width: { type: 'string' }, version: { type: 'string' }, variant: { type: 'string' },
    sessions: { type: 'string' }, 'include-synthetic': { type: 'boolean', default: false },
    detect: { type: 'boolean', default: false }, build: { type: 'boolean', default: false }, validate: { type: 'boolean', default: false },
    list: { type: 'boolean', default: false },
  },
});

const point = (v: string) => {
  const [p, q] = v.split(',').map(Number);
  if (!Number.isFinite(p) || !Number.isFinite(q)) throw new Error(`Bad point ${v}`);
  return args.wgs84 ? { latitude: p, longitude: q } : { x: p, y: q };
};

async function main() {
  if (args.list) {
    console.table((await pathfusionService.listRoutes()).map((r) => ({ name: r.name, id: r.id.slice(0, 8), passes: r.passes, version: r.fusionVersion, variant: r.fusionVariant ?? '', canonical: r.canonicalPathId?.slice(0, 8) ?? '' })));
    return;
  }
  if (!args.name) throw new Error('--name is required');
  let route = await pathfusionService.findRouteByName(args.name);
  if (args.a || args.b || !route) {
    if (!args.a || !args.b) throw new Error('A new route needs --a and --b');
    route = await pathfusionService.createRoute({ name: args.name, a: point(args.a), b: point(args.b), radiusM: args.radius ? Number(args.radius) : route?.radiusM,
      widthM: args.width ? Number(args.width) : route?.widthM, fusionVersion: args.version ?? route?.fusionVersion, fusionVariant: args.variant ?? route?.fusionVariant ?? null });
    console.log(`route ${route.name} (${route.id}): A (${route.a.x.toFixed(1)}, ${route.a.y.toFixed(1)}) → B (${route.b.x.toFixed(1)}, ${route.b.y.toFixed(1)}), radius ${route.radiusM} m`);
  }
  if (args.detect) {
    let sessionIds: string[] | undefined;
    if (args.sessions) {
      const { rows } = await pool.query<{ id: string }>('SELECT id FROM collection_sessions');
      sessionIds = args.sessions.split(',').flatMap((p) => rows.filter((r) => r.id.startsWith(p.trim())).map((r) => r.id));
    }
    console.log('passes:', await pathfusionService.detectPasses(route.id, { sessionIds, includeSynthetic: args['include-synthetic'] }));
  }
  if (args.build) {
    const c = await pathfusionService.buildCanonical(route.id);
    console.log('canonical:', JSON.stringify(c, null, 1));
    const passes = await pathfusionService.passes(route.id);
    console.table(passes.map((p) => ({ pass: p.id.slice(0, 8), session: p.sessionId.slice(0, 8), dir: p.direction, src: p.source, status: p.status, reasons: p.reasons.join(','),
      flipped: p.flipped, coverage: p.metrics.coverage, dtwM: p.metrics.dtwMeanM, seconds: Math.round((p.tEnd - p.tStart) / 1000) })));
  }
  if (args.validate) {
    const v = await pathfusionService.validate(route.id);
    console.log('validation (leave one pass out):', JSON.stringify({ passes: v.passes, pooled: v.pooled, rejectedPointRatio: v.rejectedPointRatio, fusionDownweightedRatio: v.fusionDownweightedRatio, markerSpreadM: v.markerSpreadM, markerClusters: v.markerClusters.length }, null, 1));
  }
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
