// Corrections to the building ids that spatial-import derives from the campus map shapefile
// (backend/data/campus-map/overrides/building-ids.json). The shapefile stays the source of the footprints; a
// correction only says that the id (and name) the file gives one footprint belongs to another building.
// The map version id is the hash of the shapefile alone, so a correction does not start a new map version:
// an existing database is brought in line with scripts/building-ids-rename.ts.

export interface BuildingIdFix {
  feature: string;       // "building-<n>": the n-th polygon of building.shp
  from: string;          // the id the file gives it (checked, so a reordered file is not silently renamed)
  id: string;            // the id it gets
  name: string | null;   // campus_buildings.building_name it gets
  reason: string;
}

const badId = (v: unknown) => typeof v !== 'string' || !/^[^\s#]{1,24}$/.test(v);

export function parseBuildingIdFixes(doc: unknown): BuildingIdFix[] {
  const list = (doc as { ids?: unknown })?.ids;
  if (!Array.isArray(list)) throw new Error('Building id fixes: "ids" must be an array');
  const features = new Set<string>();
  const ids = new Set<string>();
  return list.map((o: BuildingIdFix, i) => {
    const at = `Building id fixes[${i}]`;
    if (typeof o?.feature !== 'string' || !/^building-\d+$/.test(o.feature) || features.has(o.feature)) throw new Error(`${at}: feature must be a distinct "building-<n>"`);
    features.add(o.feature);
    if (badId(o.from)) throw new Error(`${at}: from must be the id the file gives ${o.feature}`);
    if (badId(o.id) || ids.has(o.id)) throw new Error(`${at}: id must be unique, 1-24 characters without spaces or #`);
    ids.add(o.id);
    if (o.name !== null && (typeof o.name !== 'string' || !o.name.trim())) throw new Error(`${at}: name must be a string or null`);
    if (typeof o.reason !== 'string' || !o.reason.trim()) throw new Error(`${at}: reason is required`);
    return { feature: o.feature, from: o.from, id: o.id, name: o.name, reason: o.reason };
  });
}

/** The id spatial-import gives a footprint without corrections: its name without spaces, or 건물<n> when it has none. */
export function defaultBuildingId(feature: { id: string; name: string | null }): string {
  return (feature.name?.replace(/\s+/g, '') ?? `건물${feature.id.split('-')[1]}`).normalize('NFC');
}

/** Ids and names of all footprints with the corrections applied. Throws when a correction no longer matches the file or two footprints end up with one id. */
export function resolveBuildingIds<T extends { id: string; name: string | null }>(features: T[], fixes: BuildingIdFix[]): (T & { buildingId: string; buildingName: string | null })[] {
  for (const f of fixes) {
    const target = features.find((x) => x.id === f.feature);
    if (!target) throw new Error(`Building id fix ${f.feature}: no such footprint in the file`);
    if (defaultBuildingId(target) !== f.from) throw new Error(`Building id fix ${f.feature}: the file gives it "${defaultBuildingId(target)}", not "${f.from}"`);
  }
  const seen = new Set<string>();
  return features.map((x) => {
    const fix = fixes.find((f) => f.feature === x.id);
    const buildingId = fix ? fix.id : defaultBuildingId(x);
    if (seen.has(buildingId)) throw new Error(`Duplicate building name/ID: ${buildingId}`);
    seen.add(buildingId);
    return { ...x, buildingId, buildingName: fix ? fix.name : x.name };
  });
}
