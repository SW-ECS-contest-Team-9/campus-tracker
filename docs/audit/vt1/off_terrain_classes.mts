// validate_network OFF_TERRAIN 전후 분류(시험 DB, 읽기만). 사용(backend 에서, DATABASE_URL=시험 DB): npx tsx ../docs/audit/vt1/off_terrain_classes.mts <structures 폴더> [terrain id] > 결과.json
const B = '../../../backend/src/';
const { pool } = await import(B + 'config/database.js');
const { terrain } = await import(B + 'geo/terrain.js');
const { editorQueries } = await import(B + 'modules/editor-mcp/editor.queries.js');
const { validateNetwork } = await import(B + 'modules/editor-mcp/network-validate.js');
const { loadStructureSurfaces, surfacesAt } = await import(B + 'modules/editor-mcp/structure-surfaces.js');

const dir = process.argv[2];
const [roads, nodes] = await Promise.all([editorQueries.roads({}), editorQueries.nodes({})]);
const active = process.argv[3] ?? await terrain.activeVersion();
const ctx = await terrain.context(active);
const ground0 = (x: number, y: number) => terrain.sampleXY(ctx, x, y)?.height ?? null;
const ground = ground0; const inBuilding = (x: number, y: number) => terrain.buildingAt(ctx, x, y).building !== null;
const t0 = Date.now();
const surfaces = loadStructureSurfaces(dir);
const at = surfacesAt(surfaces);
const tLoad = Date.now() - t0;
const noBuilding = roads.map((r: any) => ({ ...r, buildingId: null }));
const before = validateNetwork(noBuilding, nodes, ['OFF_TERRAIN'], { ground: ground0 });
const t1 = Date.now();
const after = validateNetwork(roads, nodes, ['OFF_TERRAIN'], { ground, structures: at, inBuilding });
const tCheck = Date.now() - t1;
const all = validateNetwork(roads, nodes, undefined, { ground, structures: at, inBuilding });
const allBefore = validateNetwork(noBuilding, nodes, undefined, { ground: ground0 });
const byId = new Map(roads.map((r: any) => [r.id, r]));
const afterIds = new Set(after.map((f: any) => f.roadIds[0]));
const midIds = new Set(validateNetwork(roads, nodes, ['OFF_TERRAIN'], { ground, structures: at }).map((f: any) => f.roadIds[0]));
const rows = before.map((f: any) => {
  const r: any = byId.get(f.roadIds[0]);
  // 가장 나쁜 점에서 무엇 위인가
  const p = f.location;
  const hits = at(p[0], p[1]);
  const g = ground0(p[0], p[1]); const inB = terrain.buildingAt(ctx, p[0], p[1]).building?.name ?? null;
  const near = hits.reduce((b: any, h: any) => (!b || Math.abs(p[2] - h.z) < Math.abs(p[2] - b.z) ? h : b), null);
  const cls = r.buildingId ? 'indoor' : (midIds.has(r.id) && !afterIds.has(r.id)) ? 'building-footprint' : !afterIds.has(r.id) ? (near?.type === 'void' ? 'void' : 'structure') : (['stairs', 'ramp'].includes(r.structure) ? 'connector-remaining' : 'remaining');
  const a = after.find((x: any) => x.roadIds[0] === r.id);
  return { road: r.id.slice(0, 8), name: r.name, structure: r.structure, roadClass: r.roadClass, buildingId: r.buildingId, cls,
    at: p, groundZ: g, inBuilding: inB, before: f.message.match(/ ([\d.]+) m (above|below)/)?.slice(1, 3).join(' '), nearest: near && { id: near.id, type: near.type, z: Math.round(near.z * 100) / 100 },
    after: a ? { at: a.location, msg: a.message } : null };
});
const count = (fs: any[]) => fs.reduce((m: any, f: any) => ((m[f.code] = (m[f.code] ?? 0) + 1), m), {});
console.log(JSON.stringify({ terrain: active, roads: roads.length, surfaces: surfaces.length, tLoadMs: tLoad, tCheckMs: tCheck,
  offTerrain: { before: before.length, after: after.length }, allBefore: { total: allBefore.length, ...count(allBefore) }, allAfter: { total: all.length, ...count(all) },
  classes: rows.reduce((m: any, x: any) => ((m[x.cls] = (m[x.cls] ?? 0) + 1), m), {}), rows,
  newOnly: after.filter((f: any) => !before.some((b: any) => b.roadIds[0] === f.roadIds[0])).map((f: any) => ({ road: f.roadIds[0].slice(0, 8), at: f.location, msg: f.message })) }, null, 1));
await pool.end();
