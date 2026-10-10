// Roof overrides for the scene import (backend/data/scene/overrides/building-roofs.json). The GeoPackage stays the
// source of footprints and heights; an override replaces one building's roof elevation with a value read elsewhere
// and must say where it comes from. Without overrides the import and its version id are exactly as before.
import { createHash } from 'node:crypto';
import type { BlockHeights } from './scene-heights.js';

export interface RoofOverride {
  name: string;          // buildings_3d.name in the GeoPackage
  roofM: number;         // roof elevation, orthometric (Incheon MSL)
  heightSource: string;  // stored in scene_buildings.height_source (VARCHAR(16)); not REGISTER / ESTIMATE
  evidence: { source: string; collectedOn: string; level: string; independentSurvey: boolean; [k: string]: unknown };
}

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
    if (typeof o.heightSource !== 'string' || !/^[A-Z_]{1,16}$/.test(o.heightSource) || o.heightSource === 'REGISTER' || o.heightSource === 'ESTIMATE')
      throw new Error(`${at} ${o.name}: heightSource must be its own label (A-Z_, at most 16 characters)`);
    const e = o.evidence;
    if (!e || [e.source, e.collectedOn, e.level].some((v) => typeof v !== 'string' || !v) || typeof e.independentSurvey !== 'boolean')
      throw new Error(`${at} ${o.name}: evidence needs source, collectedOn, level and independentSurvey`);
    return { name: o.name, roofM: o.roofM, heightSource: o.heightSource, evidence: e };
  });
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
