// Overrides for the scene import (backend/data/scene/overrides/building-roofs.json). The GeoPackage stays the
// source of footprints and heights; an override replaces one building's roof elevation with a value read elsewhere
// ("buildings"), leaves a building of the GeoPackage out of the scene ("hidden"), or draws one footprint as several
// blocks with their own roofs ("parts"). Each must say where it comes from. Without overrides the import and its
// version id are exactly as before.
import { createHash } from 'node:crypto';
import type { BlockHeights } from './scene-heights.js';

export interface Evidence { source: string; collectedOn: string; level: string; independentSurvey: boolean; [k: string]: unknown }
export interface RoofOverride {
  name: string;          // buildings_3d.name in the GeoPackage
  roofM: number;         // roof elevation, orthometric (Incheon MSL)
  heightSource: string;  // stored in scene_buildings.height_source (VARCHAR(16)); not REGISTER / ESTIMATE
  floors?: number;       // stated floor count (scene_buildings.ground_floors); without it an assumed GeoPackage count is not carried over
  evidence: Evidence;
}
export interface HiddenBuilding { name: string; reason: string; evidence: Evidence }
export type PartRing = [number, number][];
/** One block of a split footprint: an EPSG:5186 polygon (outer ring, then holes) with a flat roof. `name` is the map label (null = no label). */
export interface BuildingPart { id: string; name: string | null; roofM: number; polygon: PartRing[] }
/** `floors` (stated floor count of the building) is stored on the parts that carry a label. */
export interface BuildingParts { name: string; heightSource: string; floors?: number; evidence: Evidence; parts: BuildingPart[] }
export interface SceneOverrides { roofs: RoofOverride[]; hidden: HiddenBuilding[]; parts: BuildingParts[] }

const badEvidence = (e: Evidence | undefined) =>
  !e || [e.source, e.collectedOn, e.level].some((v) => typeof v !== 'string' || !v) || typeof e.independentSurvey !== 'boolean';
const badFloors = (v: unknown) => v !== undefined && !(Number.isInteger(v) && (v as number) > 0 && (v as number) < 200);
const badSource = (v: unknown) => typeof v !== 'string' || !/^[A-Z_]{1,16}$/.test(v) || v === 'REGISTER' || v === 'ESTIMATE';

export function parseRoofOverrides(doc: unknown): RoofOverride[] {
  const list = (doc as { buildings?: unknown })?.buildings;
  if (!Array.isArray(list)) throw new Error('Roof overrides: "buildings" must be an array');
  const seen = new Set<string>();
  return list.map((o: RoofOverride, i) => {
    const at = `Roof overrides[${i}]`;
    if (typeof o?.name !== 'string' || !o.name) throw new Error(`${at}: name is required`);
    if (seen.has(o.name)) throw new Error(`${at}: ${o.name} listed twice`);
    seen.add(o.name);
    if (!Number.isFinite(o.roofM)) throw new Error(`${at} ${o.name}: roofM must be a number`);
    if (badSource(o.heightSource)) throw new Error(`${at} ${o.name}: heightSource must be its own label (A-Z_, at most 16 characters)`);
    if (badFloors(o.floors)) throw new Error(`${at} ${o.name}: floors must be a positive whole number`);
    if (badEvidence(o.evidence)) throw new Error(`${at} ${o.name}: evidence needs source, collectedOn, level and independentSurvey`);
    return { name: o.name, roofM: o.roofM, heightSource: o.heightSource, ...(o.floors === undefined ? {} : { floors: o.floors }), evidence: o.evidence };
  });
}

/** Shoelace area of a closed ring (m2, unsigned). */
export function ringArea(ring: PartRing): number {
  let a = 0;
  for (let i = 1; i < ring.length; i++) a += ring[i - 1][0] * ring[i][1] - ring[i][0] * ring[i - 1][1];
  return Math.abs(a) / 2;
}

/** Area of a polygon given as outer ring + holes. */
export function polygonArea(rings: PartRing[]): number {
  return ringArea(rings[0]) - rings.slice(1).reduce((s, hole) => s + ringArea(hole), 0);
}

/** The whole overrides file. A building may appear in only one of "buildings", "hidden" and "parts". */
export function parseSceneOverrides(doc: unknown): SceneOverrides {
  const d = doc as { hidden?: unknown; parts?: unknown };
  const roofs = parseRoofOverrides(doc);
  const seen = new Set(roofs.map((o) => o.name));
  const once = (at: string, name: unknown) => {
    if (typeof name !== 'string' || !name) throw new Error(`${at}: name is required`);
    if (seen.has(name)) throw new Error(`${at}: ${name} listed twice`);
    seen.add(name);
  };
  if (d.hidden !== undefined && !Array.isArray(d.hidden)) throw new Error('Scene overrides: "hidden" must be an array');
  if (d.parts !== undefined && !Array.isArray(d.parts)) throw new Error('Scene overrides: "parts" must be an array');
  const hidden = ((d.hidden ?? []) as HiddenBuilding[]).map((o, i) => {
    const at = `Hidden buildings[${i}]`;
    once(at, o?.name);
    if (typeof o.reason !== 'string' || !o.reason) throw new Error(`${at} ${o.name}: reason is required`);
    if (badEvidence(o.evidence)) throw new Error(`${at} ${o.name}: evidence needs source, collectedOn, level and independentSurvey`);
    return { name: o.name, reason: o.reason, evidence: o.evidence };
  });
  const parts = ((d.parts ?? []) as BuildingParts[]).map((o, i) => {
    const at = `Building parts[${i}]`;
    once(at, o?.name);
    if (badSource(o.heightSource)) throw new Error(`${at} ${o.name}: heightSource must be its own label (A-Z_, at most 16 characters)`);
    if (badEvidence(o.evidence)) throw new Error(`${at} ${o.name}: evidence needs source, collectedOn, level and independentSurvey`);
    if (badFloors(o.floors)) throw new Error(`${at} ${o.name}: floors must be a positive whole number`);
    if (!Array.isArray(o.parts) || o.parts.length < 2) throw new Error(`${at} ${o.name}: at least two parts`);
    const ids = new Set<string>();
    const list = o.parts.map((p, k) => {
      const pat = `${at} ${o.name} part ${k}`;
      if (typeof p?.id !== 'string' || !/^[^\s#]{1,24}$/.test(p.id) || ids.has(p.id)) throw new Error(`${pat}: id must be unique, 1-24 characters without spaces or #`);
      ids.add(p.id);
      if (p.name != null && (typeof p.name !== 'string' || !p.name)) throw new Error(`${pat}: name must be a string or null`);
      if (!Number.isFinite(p.roofM)) throw new Error(`${pat}: roofM must be a number`);
      const closed = (r: PartRing) => Array.isArray(r) && r.length >= 4 && r.every((c) => Array.isArray(c) && c.length === 2 && c.every(Number.isFinite)) && r[0][0] === r.at(-1)![0] && r[0][1] === r.at(-1)![1];
      if (!Array.isArray(p.polygon) || !p.polygon.length || !p.polygon.every(closed)) throw new Error(`${pat}: polygon must be closed rings of [x, y] (EPSG:5186), outer ring first`);
      if (!(polygonArea(p.polygon) > 1)) throw new Error(`${pat}: polygon area must be over 1 m2`);
      return { id: p.id, name: p.name ?? null, roofM: p.roofM, polygon: p.polygon };
    });
    return { name: o.name, heightSource: o.heightSource, ...(o.floors === undefined ? {} : { floors: o.floors }), evidence: o.evidence, parts: list };
  });
  return { roofs, hidden, parts };
}

/** scene_buildings.building_id of a part: the first part keeps the building's id, so references to it stay valid. */
export function partBuildingId(buildingId: string, parts: BuildingPart[], index: number): string {
  return index === 0 ? buildingId : `${buildingId}#${parts[index].id}`;
}

/** Parts must tile the footprint: their areas add up to its area (that each lies inside it is checked in PostGIS by the import). */
export function partsAreaProblem(o: BuildingParts, footprintAreaM2: number, toleranceM2 = 1): string | null {
  const sum = o.parts.reduce((s, p) => s + polygonArea(p.polygon), 0);
  return Math.abs(sum - footprintAreaM2) > toleranceM2 ? `parts of ${o.name} cover ${sum.toFixed(1)} m2, the footprint is ${footprintAreaM2.toFixed(1)} m2` : null;
}

/** The overridden roof on the building's own ground: height_m is kept consistent with roof = median(samples) + height. */
export function overrideHeights(samples: number[], h: BlockHeights, roofM: number): { heightM: number; roofM: number } {
  if (!(roofM > h.terrainMaxM)) throw new Error(`roof override ${roofM} is not above the ground ${h.terrainMaxM}`);
  const s = [...samples].sort((a, b) => a - b);
  const med = s.length % 2 ? s[s.length >> 1] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
  return { heightM: Math.round((roofM - med) * 1000) / 1000, roofM };
}

/** campus3d-<sha8>. overridesSha is given only when overrides are applied, so the id without them does not change. */
export function sceneVersionId(gpkgSha: string, terrainVersion: string, mapVersion: string, mode: string, overridesSha?: string): string {
  const key = `${gpkgSha}#${terrainVersion}#${mapVersion}#${mode}${overridesSha ? `#roofs:${overridesSha}` : ''}`;
  return `campus3d-${createHash('sha256').update(key).digest('hex').slice(0, 8)}`;
}
