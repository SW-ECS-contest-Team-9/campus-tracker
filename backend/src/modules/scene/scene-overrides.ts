// Overrides for the scene import (backend/data/scene/overrides/building-roofs.json). The GeoPackage stays the
// source of footprints and heights; an override replaces one building's roof elevation with a value read elsewhere
// ("buildings"), leaves a building of the GeoPackage out of the scene ("hidden"), or draws one footprint as several
// blocks with their own roofs ("parts"), or adds a building the GeoPackage and the campus map do not have ("added":
// its own outline, drawn in the scene only). Each must say where it comes from. Without overrides the import and its
// version id are exactly as before.
import { createHash } from 'node:crypto';
import type { BlockHeights } from './scene-heights.js';

export interface Evidence { source: string; collectedOn: string; level: string; independentSurvey: boolean; [k: string]: unknown }
export interface RoofOverride {
  name: string;          // buildings_3d.name in the GeoPackage
  roofM: number;         // roof elevation, orthometric (Incheon MSL)
  heightSource: string;  // stored in scene_buildings.height_source (VARCHAR(16)); not REGISTER / ESTIMATE
  floors?: number;       // stated floor count (scene_buildings.ground_floors); without it an assumed GeoPackage count is not carried over
  /** Why the roof may lie below the highest ground on the outline (a roof deck level with the upper ground of a slope). Without it the roof must clear all of the ground. */
  terrace?: string;
  evidence: Evidence;
}
export interface HiddenBuilding { name: string; reason: string; evidence: Evidence }
export type PartRing = [number, number][];
/** One block of a split footprint: an EPSG:5186 polygon (outer ring, then holes) with a flat roof. `name` is the map label (null = no label). */
export interface BuildingPart {
  id: string; name: string | null; roofM: number; polygon: PartRing[];
  /** Why this part's roof may lie below the highest ground on its outline (a deck level with the upper ground of a slope). Without it the roof must clear all of the ground. */
  terrace?: string;
}
/**
 * `floors` (stated floor count of the building) is stored on the parts that carry a label.
 * `uncovered` says what the rest of the footprint is when the parts do not tile it (that area is not drawn); without it they must tile it.
 */
export interface BuildingParts { name: string; heightSource: string; floors?: number; uncovered?: string; evidence: Evidence; parts: BuildingPart[] }
/**
 * A building that is in neither the GeoPackage nor the campus map: one flat-roofed block on its own EPSG:5186 outline.
 * `id` becomes scene_buildings.building_id (it must not be a campus map building id); `name` is the map label and may
 * repeat a GeoPackage name only if that GeoPackage building is hidden. The base comes from the terrain like any block.
 */
export interface AddedBuilding { id: string; name: string; roofM: number; heightSource: string; floors?: number; registerId?: string; polygon: PartRing[]; evidence: Evidence }
export interface SceneOverrides { roofs: RoofOverride[]; hidden: HiddenBuilding[]; parts: BuildingParts[]; added: AddedBuilding[] }

const badEvidence = (e: Evidence | undefined) =>
  !e || [e.source, e.collectedOn, e.level].some((v) => typeof v !== 'string' || !v) || typeof e.independentSurvey !== 'boolean';
const badFloors = (v: unknown) => v !== undefined && !(Number.isInteger(v) && (v as number) > 0 && (v as number) < 200);
const badReason = (v: unknown) => v !== undefined && (typeof v !== 'string' || !v.trim());
const badId = (v: unknown) => typeof v !== 'string' || !/^[^\s#]{1,24}$/.test(v);
const closedRing = (r: PartRing) => Array.isArray(r) && r.length >= 4 && r.every((c) => Array.isArray(c) && c.length === 2 && c.every(Number.isFinite)) && r[0][0] === r.at(-1)![0] && r[0][1] === r.at(-1)![1];
const badPolygon = (p: unknown) => !Array.isArray(p) || !p.length || !p.every(closedRing);
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
    if (badReason(o.terrace)) throw new Error(`${at} ${o.name}: terrace must say why the roof may lie below the higher ground`);
    if (badEvidence(o.evidence)) throw new Error(`${at} ${o.name}: evidence needs source, collectedOn, level and independentSurvey`);
    return { name: o.name, roofM: o.roofM, heightSource: o.heightSource, ...(o.floors === undefined ? {} : { floors: o.floors }), ...(o.terrace === undefined ? {} : { terrace: o.terrace }), evidence: o.evidence };
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
  const d = doc as { hidden?: unknown; parts?: unknown; added?: unknown };
  const roofs = parseRoofOverrides(doc);
  const seen = new Set(roofs.map((o) => o.name));
  const once = (at: string, name: unknown) => {
    if (typeof name !== 'string' || !name) throw new Error(`${at}: name is required`);
    if (seen.has(name)) throw new Error(`${at}: ${name} listed twice`);
    seen.add(name);
  };
  if (d.hidden !== undefined && !Array.isArray(d.hidden)) throw new Error('Scene overrides: "hidden" must be an array');
  if (d.parts !== undefined && !Array.isArray(d.parts)) throw new Error('Scene overrides: "parts" must be an array');
  if (d.added !== undefined && !Array.isArray(d.added)) throw new Error('Scene overrides: "added" must be an array');
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
    if (badReason(o.uncovered)) throw new Error(`${at} ${o.name}: uncovered must say what the rest of the footprint is`);
    if (!Array.isArray(o.parts) || o.parts.length < 2) throw new Error(`${at} ${o.name}: at least two parts`);
    const ids = new Set<string>();
    const list = o.parts.map((p, k) => {
      const pat = `${at} ${o.name} part ${k}`;
      if (badId(p?.id) || ids.has(p.id)) throw new Error(`${pat}: id must be unique, 1-24 characters without spaces or #`);
      ids.add(p.id);
      if (p.name != null && (typeof p.name !== 'string' || !p.name)) throw new Error(`${pat}: name must be a string or null`);
      if (!Number.isFinite(p.roofM)) throw new Error(`${pat}: roofM must be a number`);
      if (badPolygon(p.polygon)) throw new Error(`${pat}: polygon must be closed rings of [x, y] (EPSG:5186), outer ring first`);
      if (!(polygonArea(p.polygon) > 1)) throw new Error(`${pat}: polygon area must be over 1 m2`);
      if (badReason(p.terrace)) throw new Error(`${pat}: terrace must say why the roof may lie below the higher ground`);
      return { id: p.id, name: p.name ?? null, roofM: p.roofM, polygon: p.polygon, ...(p.terrace === undefined ? {} : { terrace: p.terrace }) };
    });
    return { name: o.name, heightSource: o.heightSource, ...(o.floors === undefined ? {} : { floors: o.floors }), ...(o.uncovered === undefined ? {} : { uncovered: o.uncovered }), evidence: o.evidence, parts: list };
  });
  const drawn = new Set([...roofs, ...parts].map((o) => o.name)); // GeoPackage buildings that stay on the map under their name
  const addedIds = new Set<string>();
  const addedNames = new Set<string>();
  const added = ((d.added ?? []) as AddedBuilding[]).map((o, i) => {
    const at = `Added buildings[${i}]`;
    if (badId(o?.id) || addedIds.has(o.id)) throw new Error(`${at}: id must be unique, 1-24 characters without spaces or #`);
    addedIds.add(o.id);
    if (typeof o.name !== 'string' || !o.name.trim()) throw new Error(`${at} ${o.id}: name is required`);
    if (drawn.has(o.name) || addedNames.has(o.name)) throw new Error(`${at} ${o.id}: ${o.name} listed twice`);
    addedNames.add(o.name);
    if (!Number.isFinite(o.roofM)) throw new Error(`${at} ${o.id}: roofM must be a number`);
    if (badSource(o.heightSource)) throw new Error(`${at} ${o.id}: heightSource must be its own label (A-Z_, at most 16 characters)`);
    if (badFloors(o.floors)) throw new Error(`${at} ${o.id}: floors must be a positive whole number`);
    if (o.registerId !== undefined && (typeof o.registerId !== 'string' || !o.registerId)) throw new Error(`${at} ${o.id}: registerId must be a string`);
    if (badPolygon(o.polygon)) throw new Error(`${at} ${o.id}: polygon must be closed rings of [x, y] (EPSG:5186), outer ring first`);
    if (!(polygonArea(o.polygon) > 1)) throw new Error(`${at} ${o.id}: polygon area must be over 1 m2`);
    if (badEvidence(o.evidence)) throw new Error(`${at} ${o.id}: evidence needs source, collectedOn, level and independentSurvey`);
    return { id: o.id, name: o.name, roofM: o.roofM, heightSource: o.heightSource, ...(o.floors === undefined ? {} : { floors: o.floors }),
      ...(o.registerId === undefined ? {} : { registerId: o.registerId }), polygon: o.polygon, evidence: o.evidence };
  });
  return { roofs, hidden, parts, added };
}

/** scene_buildings.building_id of a part: the first part keeps the building's id, so references to it stay valid. */
export function partBuildingId(buildingId: string, parts: BuildingPart[], index: number): string {
  return index === 0 ? buildingId : `${buildingId}#${parts[index].id}`;
}

/**
 * Parts must tile the footprint: their areas add up to its area (that each lies inside it is checked in PostGIS by the import).
 * With `uncovered` they may cover less, never more (that they do not overlap is then checked in PostGIS as well).
 */
export function partsAreaProblem(o: BuildingParts, footprintAreaM2: number, toleranceM2 = 1): string | null {
  const sum = o.parts.reduce((s, p) => s + polygonArea(p.polygon), 0);
  if (o.uncovered !== undefined) return sum > footprintAreaM2 + toleranceM2 ? `parts of ${o.name} cover ${sum.toFixed(1)} m2, more than the footprint ${footprintAreaM2.toFixed(1)} m2` : null;
  return Math.abs(sum - footprintAreaM2) > toleranceM2 ? `parts of ${o.name} cover ${sum.toFixed(1)} m2, the footprint is ${footprintAreaM2.toFixed(1)} m2` : null;
}

/**
 * The overridden roof on the building's own ground: height_m is kept consistent with roof = median(samples) + height.
 * The roof must be above all of the ground; a terrace (a part that says so) only above the median ground, so that it still
 * stands out of the slope on its lower side and its height stays positive.
 */
export function overrideHeights(samples: number[], h: BlockHeights, roofM: number, terrace = false): { heightM: number; roofM: number } {
  const s = [...samples].sort((a, b) => a - b);
  const med = s.length % 2 ? s[s.length >> 1] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
  if (terrace ? !(roofM > med) : !(roofM > h.terrainMaxM)) throw new Error(terrace ? `terrace roof ${roofM} is not above the median ground ${med}` : `roof override ${roofM} is not above the ground ${h.terrainMaxM}`);
  return { heightM: Math.round((roofM - med) * 1000) / 1000, roofM };
}

/** campus3d-<sha8>. overridesSha is given only when overrides are applied, so the id without them does not change. */
export function sceneVersionId(gpkgSha: string, terrainVersion: string, mapVersion: string, mode: string, overridesSha?: string): string {
  const key = `${gpkgSha}#${terrainVersion}#${mapVersion}#${mode}${overridesSha ? `#roofs:${overridesSha}` : ''}`;
  return `campus3d-${createHash('sha256').update(key).digest('hex').slice(0, 8)}`;
}

/**
 * qgis:sync matches scene rows to GeoPackage rows by name. Rows of added buildings (not in the GeoPackage) and every row of a
 * hidden or split building are left out: the first part of a split keeps the building's name but carries only that part's heights.
 */
export function gpkgSyncRows<T extends { building_id: string; name: string | null }>(scene: T[],
  metadata: { hiddenBuildings?: { name: string }[]; buildingParts?: { name: string }[]; addedBuildings?: { id: string }[] } | null | undefined): { rows: T[]; kept: Set<string> } {
  const added = new Set((metadata?.addedBuildings ?? []).map((o) => o.id));
  const kept = new Set([...(metadata?.hiddenBuildings ?? []), ...(metadata?.buildingParts ?? [])].map((o) => o.name));
  return { rows: scene.filter((b) => !added.has(b.building_id) && !(b.name !== null && kept.has(b.name))), kept };
}
