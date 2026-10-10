// A terrain recipe stacks the existing terrain edits on ONE base version, in order, into one derived candidate:
//   local-samples (pull towards ground samples) -> plateau (flatten polygons) -> corridor (burn road profiles in).
// Each step works on the result of the previous one. The candidate id depends only on the base id, the recipe and
// the content of its input files (and the building footprints when they are protected), so the same recipe on the
// same base gives the same id on every machine. Pure: files and the database are read by scripts/terrain-recipe.ts.
import { createHash } from 'node:crypto';
import type { Grid } from './dem.js';
import { burnCorridors, polygonsMask, CORRIDOR_DEFAULTS, type CorridorLine } from './terrain-corridor.js';
import { applyLocalSamples, changeStats, mergeLocalSampleInputs, parseLocalSamples } from './terrain-local-samples.js';
import { applyPlateau } from './terrain-plateau.js';

export const RECIPE_ALGORITHM = 'terrain-recipe-v1';
/** Plateau edge used by recipes: 3 m flat margin (> the 2.83 m diagonal of the 2 m grid), then a 4 m fade. */
export const PLATEAU_EDGE_DEFAULTS = { marginM: 3, blendM: 4 };

type Polygons = [number, number][][][];
interface MaskRefs {
  /** File (GeoJSON polygons) whose cells this step must not change, e.g. the plateau file of an earlier step. */
  keep?: string;
  /** File (GeoJSON polygons) where this step must not fade: a known wall or bank. */
  noBlend?: string;
}
export type RecipeStep =
  | { type: 'local-samples'; files: string[]; areas?: string[] }
  | ({ type: 'plateau'; file: string; marginM?: number; blendM?: number } & MaskRefs)
  | ({ type: 'corridor'; file: string; lines?: string[]; shoulderM?: number; blendM?: number } & MaskRefs);
export interface Recipe {
  crs: 'EPSG:5186';
  reason: string;
  /** Building footprint cells are never changed by plateau and corridor steps (the walls stay where they are). */
  protectBuildings: boolean;
  steps: RecipeStep[];
}

const isNum = (v: unknown) => v === undefined || (typeof v === 'number' && v >= 0 && Number.isFinite(v));
const isFile = (v: unknown) => typeof v === 'string' && v.length > 0;

export function parseRecipe(input: any): Recipe {
  if (input?.crs !== 'EPSG:5186' || typeof input.reason !== 'string' || !input.reason.trim() ||
      typeof input.protectBuildings !== 'boolean' || !Array.isArray(input.steps) || !input.steps.length) {
    throw new Error('Expected recipe with crs=EPSG:5186, reason, protectBuildings and steps');
  }
  input.steps.forEach((s: any, k: number) => {
    const masksOk = (s.keep === undefined || isFile(s.keep)) && (s.noBlend === undefined || isFile(s.noBlend));
    const ok = s?.type === 'local-samples' ? Array.isArray(s.files) && s.files.length > 0 && s.files.every(isFile) && (s.areas === undefined || (Array.isArray(s.areas) && s.areas.every(isFile)))
      : s?.type === 'plateau' ? isFile(s.file) && isNum(s.marginM) && isNum(s.blendM) && masksOk
      : s?.type === 'corridor' ? isFile(s.file) && isNum(s.shoulderM) && isNum(s.blendM) && masksOk && (s.lines === undefined || (Array.isArray(s.lines) && s.lines.length > 0 && s.lines.every(isFile)))
      : false;
    if (!ok) throw new Error(`Invalid recipe step ${k + 1}`);
  });
  return input as Recipe;
}

/** Every file a recipe reads, in order of first use. */
export function recipeFiles(recipe: Recipe): string[] {
  const files = recipe.steps.flatMap((s) => [...(s.type === 'local-samples' ? s.files : [s.file, s.keep, s.noBlend])]);
  return [...new Set(files.filter((f): f is string => !!f))];
}

/** Polygons of a GeoJSON Feature or FeatureCollection (EPSG:5186). Plateau features also need heightM and reason. */
export function parsePolygons(input: any, plateau = false): { name: string; rings: [number, number][][]; heightM: number; reason: string }[] {
  const features = input?.type === 'FeatureCollection' ? input.features : input?.type === 'Feature' ? [input] : null;
  if (!Array.isArray(features) || !features.length) throw new Error('Expected GeoJSON Feature or FeatureCollection of polygons');
  return features.map((f: any, k: number) => {
    const rings = f?.geometry?.type === 'Polygon' ? f.geometry.coordinates : null;
    const p = f?.properties ?? {};
    if (!Array.isArray(rings) || !rings.length || rings.some((r: any) => !Array.isArray(r) || r.length < 4 || r.some((c: any) => !Array.isArray(c) || !c.slice(0, 2).every(Number.isFinite))) ||
        p.srid !== 5186 || typeof p.reason !== 'string' || !p.reason.trim() || (plateau && !Number.isFinite(p.heightM))) {
      throw new Error(`Polygon ${k + 1}: expected Polygon with srid=5186 and reason${plateau ? ', finite heightM' : ''}`);
    }
    return { name: String(p.name ?? k + 1), rings: rings.map((r: number[][]) => r.map((c) => [c[0], c[1]] as [number, number])), heightM: p.heightM, reason: p.reason.trim() };
  });
}

/** Corridor file: { crs, reason, lines: [{ name, halfWidthM, points: [x, y, z][] }] }. */
export function parseCorridors(input: any, names?: string[]): CorridorLine[] {
  if (input?.crs !== 'EPSG:5186' || typeof input.reason !== 'string' || !input.reason.trim() || !Array.isArray(input.lines)) {
    throw new Error('Expected corridor file with crs=EPSG:5186, reason and lines');
  }
  const missing = names?.filter((nm) => !input.lines.some((l: any) => l.name === nm));
  if (missing?.length) throw new Error(`No corridor line: ${missing.join(', ')}`);
  const lines = input.lines.filter((l: any) => !names || names.includes(l.name));
  if (!lines.length) throw new Error('No corridor lines');
  return lines.map((l: any) => ({ name: String(l.name), halfWidthM: l.halfWidthM, points: l.points }));
}

export interface RecipeStepResult { type: RecipeStep['type']; detail: Record<string, unknown>; changedCells: number; minDelta: number; maxDelta: number }

/** Run the steps in order on a copy of the base grid. inputs = parsed content of every file of recipeFiles();
 * buildings = footprints (polygons -> rings) for protectBuildings. */
export function applyRecipe(
  grid: Grid, base: Float32Array, recipe: Recipe, inputs: Record<string, unknown>, buildings: Polygons = [],
): { heights: Float32Array; steps: RecipeStepResult[] } {
  const need = (file: string) => {
    if (inputs[file] === undefined) throw new Error(`Recipe input not loaded: ${file}`);
    return inputs[file] as any;
  };
  const buildingMask = recipe.protectBuildings ? polygonsMask(grid, buildings) : null;
  const masks = (step: MaskRefs) => {
    const keep = step.keep ? polygonsMask(grid, parsePolygons(need(step.keep)).map((p) => p.rings)) : null;
    if (keep && buildingMask) for (let i = 0; i < keep.length; i++) if (buildingMask[i]) keep[i] = 1;
    return { keep: keep ?? buildingMask ?? undefined, noBlend: step.noBlend ? polygonsMask(grid, parsePolygons(need(step.noBlend)).map((p) => p.rings)) : undefined };
  };
  let heights = base;
  const steps: RecipeStepResult[] = [];
  for (const step of recipe.steps) {
    const before = heights;
    let detail: Record<string, unknown>;
    if (step.type === 'local-samples') {
      const { samples, groups } = parseLocalSamples(mergeLocalSampleInputs(step.files.map(need)), step.areas);
      const r = applyLocalSamples(grid, heights, samples);
      heights = r.heights;
      detail = { areas: step.areas ?? 'all', samples: samples.length, skippedSamples: r.skipped.length, groups: groups.length };
    } else if (step.type === 'plateau') {
      const edge = { marginM: step.marginM ?? PLATEAU_EDGE_DEFAULTS.marginM, blendM: step.blendM ?? PLATEAU_EDGE_DEFAULTS.blendM };
      const m = masks(step);
      const polygons = parsePolygons(need(step.file), true);
      for (const p of polygons) heights = applyPlateau(grid, heights, p.rings, p.heightM, { ...edge, ...m });
      detail = { ...edge, polygons: polygons.map((p) => ({ name: p.name, heightM: p.heightM })) };
    } else {
      const opts = { shoulderM: step.shoulderM ?? CORRIDOR_DEFAULTS.shoulderM, blendM: step.blendM ?? CORRIDOR_DEFAULTS.blendM };
      const lines = parseCorridors(need(step.file), step.lines);
      heights = burnCorridors(grid, heights, lines, opts, masks(step));
      detail = { ...opts, lines: lines.map((l) => ({ name: l.name, halfWidthM: l.halfWidthM, points: l.points.length })) };
    }
    const { changedCells, minDelta, maxDelta } = changeStats(grid, before, heights);
    steps.push({ type: step.type, detail, changedCells, minDelta, maxDelta });
  }
  if (heights === base) heights = base.slice();
  return { heights, steps };
}

const sha = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');

/** Content hashes of the recipe inputs (parsed JSON, so line endings and spacing of the files do not matter). */
export function recipeInputHashes(recipe: Recipe, inputs: Record<string, unknown>, buildings: Polygons = []) {
  return {
    files: Object.fromEntries(recipeFiles(recipe).map((f) => [f, sha(inputs[f])])),
    buildings: recipe.protectBuildings ? sha(buildings) : null,
  };
}

/** Deterministic candidate id: base version + recipe + input contents (+ protected footprints). */
export function recipeId(baseVersion: string, recipe: Recipe, inputs: Record<string, unknown>, buildings: Polygons = []): string {
  return `recipe-${sha({ algorithm: RECIPE_ALGORITHM, baseVersion, recipe, inputs: recipeInputHashes(recipe, inputs, buildings) }).slice(0, 16)}`;
}
