// Tools about seeing: show things to people in the editor, look at the map as a picture, check connectivity.
import { z } from 'zod';
import { Resvg } from '@resvg/resvg-js';
import { pool } from '../../../config/database.js';
import { Uuid } from '../../../common/dto.js';
import { AppError } from '../../../common/errors/app-error.js';
import { CAMPUS_FRAME } from '../../../geo/campus-frame.js';
import { terrain } from '../../../geo/terrain.js';
import { editorAgents, type OverlayItem } from '../../../realtime/editor.gateway.js';
import type { XYZ } from '../../editor/topology.js';
import { fusionRunsRepository } from '../../fusion/fusion-runs.repository.js';
import { editorQueries, roadLength, type NetworkNode, type NetworkRoad } from '../editor.queries.js';
import { round2, roundXYZ, simplifyIndices } from '../geometry.js';
import { renderMapSvg } from '../map-render.js';
import { SCOPE_READ, defineTool, type AgentContext } from '../mcp.context.js';
import { areaLinks } from '../area-links.js';
import { checkReachability } from '../reachability.js';
import { terrainContext } from '../terrain-access.js';

const Point = z.union([z.tuple([z.number(), z.number()]), z.tuple([z.number(), z.number(), z.number()])]).describe('[x, y] or [x, y, z] in EPSG:5186');
const ref = (ctx: AgentContext) => ({ collectorId: ctx.identity.collectorId, sessionId: ctx.sessionId, agent: ctx.agent });

/** Missing heights come from the terrain so marks sit on the ground in the 3D editor. */
async function withZ(points: (readonly number[])[]): Promise<XYZ[]> {
  const ctx = await terrainContext();
  return points.map((p) => [p[0], p[1], p[2] ?? (ctx && terrain.sampleXY(ctx, p[0], p[1])?.height) ?? 0]);
}

const Where = z.object({
  point: Point.optional(), roadId: Uuid.optional(), placeId: Uuid.optional(), nodeId: Uuid.optional(),
}).describe('One of: point, roadId, placeId, nodeId');

async function locate(where: z.infer<typeof Where>): Promise<{ coordinates: XYZ[]; label?: string }> {
  if (where.roadId) { const r = await editorQueries.road(where.roadId); return { coordinates: r.coordinates, label: r.name ?? undefined }; }
  if (where.placeId) { const p = await editorQueries.place(where.placeId); return { coordinates: [p.coordinate], label: p.name }; }
  if (where.nodeId) return { coordinates: [(await editorQueries.node(where.nodeId)).coordinate] };
  if (where.point) return { coordinates: await withZ([where.point]) };
  throw AppError.badRequest('INVALID_TARGET', 'Give point, roadId, placeId or nodeId');
}

const showOverlay = defineTool({
  name: 'show_overlay',
  title: 'Point things out on the map',
  description: 'Temporarily mark points, lines or existing roads/places/nodes with labels in the editor of everyone connected (magenta, "AI" tagged). '
    + 'Nothing is saved. Use it to show where findings or proposals are. Replaces your previous overlay; expires by itself.',
  input: z.object({
    items: z.array(z.object({
      point: Point.optional(), line: z.array(Point).min(2).max(500).optional(), roadId: Uuid.optional(), placeId: Uuid.optional(), nodeId: Uuid.optional(),
      label: z.string().max(60).optional(),
    })).min(1).max(50),
    ttlSec: z.number().int().min(10).max(1800).default(300),
  }),
  scope: SCOPE_READ,
  annotations: { readOnlyHint: false, idempotentHint: true },
  async run(a, ctx) {
    const items: OverlayItem[] = [];
    for (const item of a.items) {
      const found = item.line ? { coordinates: await withZ(item.line), label: undefined } : await locate(item);
      items.push({ kind: found.coordinates.length > 1 ? 'line' : 'point', coordinates: found.coordinates, label: item.label ?? found.label, style: 'highlight' });
    }
    editorAgents.touch(ref(ctx), items[0].coordinates[0]);
    const { viewers } = editorAgents.overlay(ref(ctx), items, a.ttlSec);
    return { shown: items.length, expiresInSec: a.ttlSec, viewers, ...(viewers ? {} : { note: 'Nobody has the editor open right now, so no one sees this.' }) };
  },
});

const clearOverlay = defineTool({
  name: 'clear_overlay',
  title: 'Remove your marks',
  description: 'Remove the overlay you are currently showing in the editor (from show_overlay or a dry run).',
  input: z.object({}),
  scope: SCOPE_READ,
  annotations: { readOnlyHint: false, idempotentHint: true },
  async run(_a, ctx) {
    editorAgents.clearOverlay(ref(ctx));
    return { cleared: true };
  },
});

const focusView = defineTool({
  name: 'focus_view',
  title: 'Turn people\'s view to a place',
  description: 'Ask the open editors to fly their camera to a point or object. Only editors where the person enabled "AI 화면 안내" follow; others just see your cursor there.',
  input: z.object({ target: Where, rangeM: z.number().min(10).max(2000).default(80).describe('Camera distance') , label: z.string().max(60).optional() }),
  scope: SCOPE_READ,
  annotations: { readOnlyHint: false, idempotentHint: true },
  async run(a, ctx) {
    const found = await locate(a.target);
    const at = found.coordinates[Math.floor(found.coordinates.length / 2)];
    editorAgents.touch(ref(ctx), at);
    const { viewers } = editorAgents.focus(ref(ctx), at, a.rangeM, a.label ?? found.label);
    return { at: roundXYZ(at), viewers, note: 'Editors follow only if the person turned on "AI 화면 안내".' };
  },
});

function snapNode(nodes: NetworkNode[], used: Set<string>, p: readonly number[], levelId?: string | null) {
  let best: { node: NetworkNode; d: number } | null = null;
  for (const n of nodes) {
    if (!used.has(n.id) || (levelId !== undefined && n.levelId !== levelId)) continue;
    const d = Math.hypot(n.coordinate[0] - p[0], n.coordinate[1] - p[1]);
    if (!best || d < best.d) best = { node: n, d };
  }
  return best;
}

const checkReachabilityTool = defineTool({
  name: 'check_reachability',
  title: 'Is B reachable from A',
  description: 'Network check, not a route planner: can you get from one place to another along the drawn roads on foot, by vehicle or by wheelchair? '
    + 'Returns the connecting roads and length, or how far the search got and which roads block it. Access "unknown"/"restricted" counts as not passable '
    + 'unless assumeUnknownAllowed is set. Start and end snap to the nearest network node. Open areas count as walkable space: nodes standing on an '
    + 'area at its floor height are joined across it (roadId "area:<areaId>:<node>:<node>", pedestrians only).',
  input: z.object({
    from: Where, to: Where,
    mode: z.enum(['pedestrian', 'vehicle', 'wheelchair']).default('pedestrian'),
    assumeUnknownAllowed: z.boolean().default(false),
    snapRadiusM: z.number().positive().max(200).default(30),
  }),
  scope: SCOPE_READ,
  annotations: { readOnlyHint: true, idempotentHint: true },
  async run(a) {
    const [roads, nodes, areas] = await Promise.all([editorQueries.roads(), editorQueries.nodes(), editorQueries.areas()]);
    const used = new Set(roads.flatMap((r) => [r.fromNodeId, r.toNodeId]));
    const end = async (where: z.infer<typeof Where>, name: string) => {
      if (where.nodeId) { if (!used.has(where.nodeId)) throw AppError.badRequest('NODE_UNUSED', `${name}: no active road uses that node`); return { nodeId: where.nodeId, snapDistanceM: 0 }; }
      const found = await locate(where);
      const p = where.roadId && name === 'to' ? found.coordinates.at(-1)! : found.coordinates[0];
      const hit = snapNode(nodes, used, p);
      if (!hit || hit.d > a.snapRadiusM) throw AppError.badRequest('NO_NETWORK_NEARBY', `${name}: no network node within ${a.snapRadiusM} m`, hit ? { nearestM: round2(hit.d) } : undefined);
      return { nodeId: hit.node.id, snapDistanceM: round2(hit.d) };
    };
    const [from, to] = [await end(a.from, 'from'), await end(a.to, 'to')];
    const graph = [...roads.map((r: NetworkRoad) => ({ ...r, lengthM: roadLength(r) })), ...areaLinks(areas, nodes)];
    const result = checkReachability(graph, nodes, from.nodeId, to.nodeId, a.mode, a.assumeUnknownAllowed);
    if (result.reachable) return { mode: a.mode, from, to, reachable: true, lengthM: round2(result.lengthM), roads: result.roads.map((r) => ({ ...r, lengthM: round2(r.lengthM) })) };
    return { mode: a.mode, from, to, ...result, closestReached: result.closestReached && { ...result.closestReached, distanceM: round2(result.closestReached.distanceM) } };
  },
});

const renderMap = defineTool({
  name: 'render_map',
  title: 'Look at the map',
  description: 'A top-down picture (north up) of an area: buildings, roads colored by class (green pedestrian, orange vehicle, purple shared), nodes '
    + '(yellow = junction, white = dead end), places, optional fusion tracks and your own marks. Use it to check a result visually. '
    + 'Give bbox, or center + radiusM. The picture shows saved data only.',
  input: z.object({
    bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]).optional().describe('[minX, minY, maxX, maxY]'),
    center: z.tuple([z.number(), z.number()]).optional(), radiusM: z.number().positive().max(1000).default(60),
    widthPx: z.number().int().min(300).max(1400).default(900),
    labels: z.boolean().default(true),
    highlightRoadIds: z.array(Uuid).max(50).default([]),
    runIds: z.array(Uuid).max(5).default([]).describe('Fusion run tracks to draw as dashed gray lines'),
    marks: z.array(z.object({ point: Point.optional(), line: z.array(Point).min(2).max(500).optional(), label: z.string().max(40).optional() })).max(30).default([]),
  }),
  scope: SCOPE_READ,
  annotations: { readOnlyHint: true, idempotentHint: true },
  async run(a) {
    let bbox = a.bbox;
    if (!bbox && a.center) bbox = [a.center[0] - a.radiusM, a.center[1] - a.radiusM, a.center[0] + a.radiusM, a.center[1] + a.radiusM];
    if (!bbox) {
      const all = (await editorQueries.roads()).flatMap((r) => r.coordinates);
      if (!all.length) throw AppError.badRequest('NOTHING_TO_SHOW', 'There are no roads yet: give bbox or center');
      bbox = [Math.min(...all.map((p) => p[0])) - 15, Math.min(...all.map((p) => p[1])) - 15, Math.max(...all.map((p) => p[0])) + 15, Math.max(...all.map((p) => p[1])) + 15];
    }
    if (bbox[2] - bbox[0] < 5 || bbox[3] - bbox[1] < 5 || bbox[2] - bbox[0] > 3000 || bbox[3] - bbox[1] > 3000) throw AppError.badRequest('INVALID_BBOX', 'The area must be between 5 m and 3000 m on each side');
    const [roads, nodes, places, buildings] = await Promise.all([
      editorQueries.roads({ bbox }), editorQueries.nodes({ bbox }), editorQueries.places({ bbox }),
      pool.query<{ name: string | null; geometry: { coordinates: number[][][][] } }>(
        `SELECT b.name, ST_AsGeoJSON(b.geom)::json geometry FROM scene_buildings b JOIN scene_versions v ON v.id = b.scene_version_id AND v.active
          WHERE b.geom && ST_MakeEnvelope($1,$2,$3,$4,5186)`, bbox),
    ]);
    const degree = new Map<string, number>();
    for (const r of await editorQueries.roads({ bbox: [bbox[0] - 50, bbox[1] - 50, bbox[2] + 50, bbox[3] + 50] })) for (const n of [r.fromNodeId, r.toNodeId]) degree.set(n, (degree.get(n) ?? 0) + 1);
    const ox = CAMPUS_FRAME.originE, oy = CAMPUS_FRAME.originN;
    const tracks = [];
    for (const runId of a.runIds) {
      const pts = (await fusionRunsRepository.positions(runId, 'FINAL')).map((p) => [p.x + ox, p.y + oy] as [number, number]);
      if (pts.length > 1) tracks.push({ label: runId.slice(0, 8), points: simplifyIndices(pts, 0.5).map((i) => pts[i]) });
    }
    const marks = [];
    for (const m of a.marks) { const c = m.line ?? (m.point ? [m.point] : null); if (c) marks.push({ label: m.label, coordinates: await withZ(c) }); }
    const highlight = new Set(a.highlightRoadIds);
    const picture = renderMapSvg({
      bbox,
      buildings: buildings.rows.map((b) => ({ name: b.name, rings: b.geometry.coordinates.flat() })),
      roads: roads.map((r) => ({ id: r.id, name: r.name, roadClass: r.roadClass, status: r.status, coordinates: r.coordinates, highlighted: highlight.has(r.id), displayColor: r.displayColor ?? null })),
      nodes: nodes.map((n) => ({ kind: n.kind, coordinate: n.coordinate, degree: degree.get(n.id) ?? 1 })),
      places: places.map((p) => ({ name: p.name, coordinate: p.coordinate })), tracks, marks,
    }, a.widthPx, a.labels);
    const png = new Resvg(picture.svg, { font: { loadSystemFonts: true } }).render().asPng();
    const data = { bbox: bbox.map(round2), widthPx: picture.widthPx, heightPx: picture.heightPx, metersPerPixel: round2(picture.metersPerPixel),
      shown: { roads: roads.length, nodes: nodes.length, places: places.length, buildings: buildings.rows.length, tracks: tracks.length },
      legend: 'green=pedestrian, orange=vehicle, purple=shared; yellow node=junction, white node=dead end; pink=place; magenta=your marks; dashed gray=fusion track' };
    return { mcpContent: [{ type: 'image' as const, data: Buffer.from(png).toString('base64'), mimeType: 'image/png' }, { type: 'text' as const, text: JSON.stringify(data) }], data };
  },
});

export const viewTools = [showOverlay, clearOverlay, focusView, checkReachabilityTool, renderMap];
