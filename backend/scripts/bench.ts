/**
 * Algorithm benchmark over a suite of routes (docs/MOBILITY_MAP_PLAN.md 4.10): the candidate fusion setting is
 * replayed (unpublished snapshots), passes are found, canonical paths built and validated leave-one-pass-out.
 * The baseline is the registered config (latest snapshots) unless --baseline=<bench id>. Prints aggregates only.
 *
 *   npm run bench -- --suite=default --candidate=fusion-v4 --set gpsGateChi2=9
 *   npm run bench -- --suite=sim --set smootherIterations=1 --variant=no-irls
 *   npm run bench -- --list
 * Suites: backend/bench/suites/<name>.json  { "routes": ["route name", ...] }
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { pool } from '../src/config/database.js';
import { REALTIME_FUSION_VERSION } from '../src/modules/fusion/fusion.algorithms.js';
import { benchResult, benchRoute, listBench, pathfusionService, storeBench, type BenchCandidate } from '../src/modules/pathfusion/pathfusion.service.js';
import { parseOverrides } from './fusion-replay-args.js';

const { values: args } = parseArgs({
  options: {
    suite: { type: 'string', default: 'default' },
    candidate: { type: 'string', default: REALTIME_FUSION_VERSION },
    set: { type: 'string', multiple: true },
    variant: { type: 'string' },
    baseline: { type: 'string' },
    list: { type: 'boolean', default: false },
  },
});

type RouteMetrics = Awaited<ReturnType<typeof benchRoute>>;
const ROWS: [string, (m: RouteMetrics) => number | null | undefined, 'lower' | 'higher' | 'info'][] = [
  ['passes', (m) => m.passes, 'info'],
  ['accepted passes', (m) => m.canonical?.passes.accepted, 'higher'],
  ['median XY (m)', (m) => m.validation.pooled.medianXY, 'lower'],
  ['P95 XY (m)', (m) => m.validation.pooled.p95XY, 'lower'],
  ['max XY (m)', (m) => m.validation.pooled.maxXY, 'lower'],
  ['median Z (m)', (m) => m.validation.pooled.medianZ, 'lower'],
  ['P95 Z (m)', (m) => m.validation.pooled.p95Z, 'lower'],
  ['corridor coverage', (m) => m.validation.pooled.corridorCoverage, 'info'],
  ['corridor half-width (m)', (m) => m.canonical?.halfWidthM.median, 'lower'],
  ['marker spread (m)', (m) => m.validation.markerSpreadM, 'lower'],
  ['rejected point ratio', (m) => m.validation.rejectedPointRatio, 'info'],
  ['fusion down-weighted', (m) => m.validation.fusionDownweightedRatio, 'info'],
];

async function main() {
  if (args.list) {
    console.table((await listBench()).map((b) => ({ id: b.id.slice(0, 8), suite: b.suite, candidate: JSON.stringify(b.candidate), baseline: b.baselineId?.slice(0, 8) ?? '', code: b.codeRef, at: b.createdAt })));
    return;
  }
  const file = path.resolve(import.meta.dirname, '..', 'bench', 'suites', `${args.suite}.json`);
  const suite = JSON.parse(fs.readFileSync(file, 'utf8')) as { routes: string[] };
  const routes = [];
  for (const name of suite.routes) {
    const r = await pathfusionService.findRouteByName(name);
    if (!r) throw new Error(`Suite ${args.suite}: route "${name}" does not exist (npm run routes:build)`);
    routes.push(r);
  }
  const overrides = parseOverrides(args.set);
  const candidate: BenchCandidate = { version: args.candidate!, variant: args.variant ?? (overrides ? 'bench' : null), overrides };

  let baselineId: string;
  let baseline: RouteMetrics[];
  if (args.baseline) {
    const b = await benchResult((await listBench(500)).find((x: { id: string }) => x.id.startsWith(args.baseline!))?.id ?? args.baseline);
    baselineId = b.id;
    baseline = b.metrics.routes;
  } else {
    baseline = [];
    for (const r of routes) baseline.push(await benchRoute(r, { version: r.fusionVersion, variant: null, overrides: null }));
    baselineId = await storeBench(args.suite!, { version: 'registered', variant: null, overrides: null }, { routes: baseline }, null);
  }
  const results: RouteMetrics[] = [];
  for (const r of routes) results.push(await benchRoute(r, candidate));
  const id = await storeBench(args.suite!, candidate, { routes: results }, baselineId);

  console.log(`bench ${args.suite}: candidate ${candidate.version}${overrides ? ` ${JSON.stringify(overrides)}` : ''} (${id.slice(0, 8)}) vs baseline ${baselineId.slice(0, 8)}\n`);
  for (const [i, r] of results.entries()) {
    const b = baseline.find((x) => x.route === r.route) ?? baseline[i];
    const table = ROWS.map(([label, f, better]) => {
      const bv = b ? f(b) : null;
      const cv = f(r);
      const delta = bv !== null && bv !== undefined && cv !== null && cv !== undefined ? Math.round((cv - bv) * 1000) / 1000 : null;
      const verdict = delta === null || better === 'info' || delta === 0 ? '' : (delta < 0) === (better === 'lower') ? 'better' : 'worse';
      return { metric: label, baseline: bv ?? '–', candidate: cv ?? '–', delta: delta ?? '', verdict };
    });
    console.log(`route: ${r.route} (${r.sessions} sessions)`);
    console.table(table);
  }
  console.log('Leave-one-pass-out errors measure repeatability; claim an accuracy gain only if the marker spread does not get worse.');
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
