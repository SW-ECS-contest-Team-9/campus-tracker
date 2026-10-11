// Draws the structures (structures.ts) and the neutral campus ground (campus-ground.ts) on a Cesium map. The preview
// and the editor both mount it through scene-layers.ts.
//  - `structures`: platform solids, boxes on them, the road colours on the platform tops, the cut faces in a cross-section;
//  - `ground`: inside the campus region the server terrain is not drawn; the neutral surface and the building
//    foundations take its place (why and by which rule: campus-ground.ts).
// The campus region is defined in ONE place: `campus` of GET /api/v1/scene (the campus outline the ground texture of
// campus-map.ts already colours ivory), read here in campusRegion().
import type { SceneBuilding } from './api';
import { GROUND, buildCampusGround, type CampusGround, type GroundBuilding, type KnownSurface } from './campus-ground';
import { pavingAppearance, pavingAttribute } from './paving-pattern';
import { growPolygons, polygonArea, polygonContains, polygonOps, type Polygon } from './polygon-ops';
import type { SurfaceContext } from './road-surface-layer';
import { clipMesh, clipPolyline, planePoint, type Mesh, type SectionPlane } from './section';
import { PRECEDENCE, SOLID_STRIDE, STRUCTURES, fillPolygons, parseStructures, polygonIntervals, sectionCaps, solidColors, solidMesh, surfaceExclusions, topHeight, topMesh, voidName, type Solid } from './structures';
import { setTerrainClip } from './terrain-clip';
import { tmForward, tmInverse } from './tm';
import type { Viewer } from './vworld';

export type StructurePart = 'structures' | 'ground';
export type StructurePick = { kind: 'structure'; id: string };
/** Something the section plane cuts (cutItems): its cut face as polygons of [distance from A, height], the stretch it spans, its heights in the middle of that. */
export type CutItem = { solid: Solid; polygons: Polygon[]; from: number; to: number; topM: number; bottomM: number; name: string | null };
/** The visible road / area surfaces as drawn (RoadSurfaceLayer.drawn()). */
export type DrawnSurfaces = { surfaces: KnownSurface[]; covered: { color: string; pattern?: number; polygons: Polygon[] }[] };

export type StructureSources = {
  /** The natural terrain at an EPSG:5186 point (the server grid). */
  terrain: (x: number, y: number) => number;
  buildings: () => SceneBuilding[];
  /** The campus outline(s) of the scene: MultiPolygons in longitude / latitude. */
  campus: () => { coordinates: number[][][][] }[];
  visible?: Partial<Record<StructurePart, boolean>>;
  /** false: a click goes through (the editor). */
  pickable?: boolean;
  /** Shows or hides the ivory campus area of the ground texture (campus-map.ts). */
  campusTint?: (show: boolean) => void;
  /** Where the structure files are (default /structures/). */
  base?: string;
};

/** Triangles in metres with a colour (0..255) per vertex, and what a click on them selects. */
type Drawable = { mesh: Mesh; stride: number; /** Colour of a vertex of `positions` (the mesh as drawn: after a cross-section cut it is not the mesh the part was built with). */ rgb: (vertex: number, positions: number[]) => number[]; pick?: StructurePick; /** Joint pattern of the faces (paving-pattern.ts), 0 or missing = none. */ pattern?: number };

async function loadJson(url: string): Promise<any | null> {
  try {
    const res = await fetch(url);
    if (!res.ok || !(res.headers.get('content-type') ?? '').includes('json')) return null; // a missing file (the dev server answers with index.html)
    return await res.json();
  } catch {
    return null;
  }
}

const css = (hex: string) => [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
const metres = (ring: number[][]) => ring.slice(0, -1).map(([lon, lat]) => { const p = tmForward(lat, lon); return [p.x, p.y]; });

export class StructuresLayer {
  private readonly prims: any;
  private solids: Solid[] = [];
  private version = 0;
  private visible: Record<StructurePart, boolean> = { structures: true, ground: true };
  private underground = false;
  private walkInside = false;
  private section: SectionPlane | null = null;
  private drawnSurfaces: DrawnSurfaces = { surfaces: [], covered: [] };
  private campus: Polygon[] | null = null;
  private ground: CampusGround | null = null;
  /** Built once per change of the data, not per frame and not per cut. */
  private structureParts: Drawable[] = [];
  private groundParts: Drawable[] = [];
  private edges: { points: number[][]; rgb: number[] }[] = [];
  private platformPolygons = new Map<Solid, Polygon[]>();
  private buildings: GroundBuilding[] = [];
  /** Files read, and features left out (unknown kind without heights, broken geometry). */
  loaded: string[] = [];
  skipped: string[] = [];
  /** How long the last build took. */
  buildMs = 0;

  constructor(private readonly viewer: Viewer, private readonly src: StructureSources) {
    this.prims = viewer.scene.primitives.add(new (window as any).Cesium.PrimitiveCollection());
    Object.assign(this.visible, src.visible);
  }

  /** Reads the structure files (the list of /structures/index.json). A missing file leaves the layer without it; nothing throws. */
  async load() {
    const base = this.src.base ?? '/structures/';
    const index = await loadJson(`${base}${STRUCTURES.indexFile}`);
    const files: string[] = Array.isArray(index) ? index.filter((f) => typeof f === 'string' && /^[\w.-]+\.geojson$/.test(f)) : STRUCTURES.files;
    const solids: Solid[] = [];
    const skipped: string[] = [];
    const loaded: string[] = [];
    for (const file of files) {
      const fc = await loadJson(`${base}${file}`);
      if (!fc) continue;
      try {
        const parsed = parseStructures(file, fc);
        solids.push(...parsed.solids);
        skipped.push(...parsed.skipped);
        loaded.push(file);
      } catch (err) {
        skipped.push(`${file}: ${(err as Error).message}`);
      }
    }
    if (skipped.length) console.warn(`structures: ${skipped.length} left out`, skipped);
    this.solids = solids;
    this.loaded = loaded;
    this.skipped = skipped;
    this.version++;
  }

  isVisible(part: StructurePart) { return this.visible[part]; }

  /** Turn a part on or off. The caller then passes the surfaces again (scene-layers.ts sync), which rebuilds and draws. */
  setVisible(part: StructurePart, visible: boolean) { this.visible[part] = visible; }

  /** The voids (underground spaces inside the platforms) show with the underground ways. */
  setUnderground(visible: boolean) {
    this.underground = visible;
    this.draw();
  }

  /**
   * F09: while the first-person walk is inside (underground or indoors) the void boxes are not drawn: they show through
   * whatever is in front of them, so from inside one they would cover the schematic room of the walk (first-person.ts).
   */
  setWalkInside(inside: boolean) {
    if (inside === this.walkInside) return;
    this.walkInside = inside;
    this.draw();
  }

  /** The feature a click selected. */
  feature(id: string): Solid | undefined { return this.solids.find((s) => s.id === id); }

  /** The campus region in metres: inside it the terrain is not drawn while `ground` is on. The one definition of "inside the campus". */
  private campusRegion(): Polygon[] {
    this.campus ??= polygonOps('union', this.src.campus().flatMap((m) => m.coordinates.map((poly) => poly.map(metres))));
    return this.campus;
  }

  private inCampus(x: number, y: number) { return this.campusRegion().some((p) => polygonContains(x, y, p)); }

  /** What the road surfaces must know: what to give way to, and where the ground beside them is drawn flush. */
  context(): SurfaceContext {
    const ground = this.visible.ground && this.campusRegion().length > 0;
    return {
      key: `${this.version}:${this.visible.structures}:${ground}`,
      exclude: this.visible.structures && this.solids.length ? { ...surfaceExclusions(this.solids), ...PRECEDENCE } : undefined,
      flush: ground ? (x, y) => this.inCampus(x, y) : undefined,
    };
  }

  /**
   * The ground as drawn at a point (the cross-section's ground line): the top of a platform, else while `ground` is on
   * a building's ground level inside its outline and the neutral surface elsewhere inside the campus (under a road or
   * an area: that surface's height), else the terrain.
   */
  groundAt(x: number, y: number): number {
    for (const [solid, polygons] of this.platformPolygons) if (polygons.some((p) => polygonContains(x, y, p))) return topHeight(solid)(x, y);
    if (this.visible.ground && this.ground) for (const b of this.buildings) if (polygonContains(x, y, b.polygon)) return b.groundM; // a step at the wall, not a ramp across it
    return this.visible.ground && this.ground && this.inCampus(x, y) ? this.ground.height(x, y) : this.src.terrain(x, y);
  }

  /** Whether the platforms that are shown are the ground of an open area (rings in longitude / latitude, closed): PRECEDENCE 4. */
  coversArea(coordinates: number[][][]): boolean {
    if (!this.platformPolygons.size) return false;
    const area = polygonOps('union', [coordinates.map(metres)]);
    const total = area.reduce((sum, p) => sum + polygonArea(p), 0);
    const on = polygonOps('both', area, [...this.platformPolygons.values()].flat()).reduce((sum, p) => sum + polygonArea(p), 0);
    return total > 0 && on / total >= PRECEDENCE.areaOnPlatformShare;
  }

  /** The visible road surfaces (built around the structures): everything is built again and drawn. */
  setSurfaces(drawn: DrawnSurfaces) {
    this.drawnSurfaces = drawn;
    const started = performance.now();
    try {
      this.build();
    } catch (err) {
      // a file that breaks the geometry must not take the map down
      console.error('structures: build failed', err);
      this.structureParts = [];
      this.groundParts = [];
      this.edges = [];
      this.ground = null;
    }
    this.buildMs = performance.now() - started;
    this.draw();
  }

  /** Cross-section (section-layer.ts): every solid and the ground are cut at the plane, the cut faces are filled; null restores. */
  setSection(plane: SectionPlane | null) {
    this.section = plane;
    this.draw();
  }

  private build() {
    const buildings: (GroundBuilding & { plinth?: string })[] = this.src.buildings().flatMap((b) => b.geometry.coordinates.map((poly) => ({
      polygon: polygonOps('union', [poly.map(metres)])[0] ?? [], groundM: b.terrainMinM ?? b.baseM + 1, baseM: b.baseM, plinth: b.appearance?.plinth?.color,
    }))).filter((b) => b.polygon.length > 0);
    this.buildings = buildings;
    const shown = this.visible.structures ? this.solids.filter((s) => s.role !== 'void') : [];
    const platforms = shown.filter((s) => s.role === 'platform');
    // a platform ends just before a building wall: its side face never lies in the wall
    const walls = platforms.length ? growPolygons(buildings.map((b) => b.polygon), 0.05) : [];
    this.platformPolygons = new Map(platforms.map((s) => [s, polygonOps('minus', [s.polygon], walls)]));

    // the ground first: the platform sides reach down to it
    this.ground = null;
    this.groundParts = [];
    if (this.visible.ground && this.campusRegion().length) {
      const known: KnownSurface[] = [
        ...platforms.map((s) => ({ polygons: this.platformPolygons.get(s)!, mesh: topMesh(s, this.platformPolygons.get(s)!), stride: 3 })),
        ...this.drawnSurfaces.surfaces,
      ];
      // a platform that reaches outside the campus (a public street below a retaining wall) belongs to the cleared region too:
      // its outer edge then meets the terrain along a straight line (the apron of campus-ground.ts), not along the terrain cells
      const region = platforms.length ? polygonOps('union', [...this.campusRegion(), ...platforms.map((s) => this.platformPolygons.get(s)!).flat()]) : this.campusRegion();
      const ground = buildCampusGround({ campus: region, terrain: this.src.terrain, buildings, known });
      this.ground = ground;
      const floor = css(GROUND.color);
      const outside = css(GROUND.outsideColor);
      // Z09: where the neutral surface has to climb steeply between two heights (a sliver between a wall and a platform, a
      // gap between two platforms) it is a wall face, not floor: those triangles are drawn in the retaining-wall tone
      const tone = css(GROUND.foundationColor);
      const flat: number[] = [], steep: number[] = [];
      const gp = ground.mesh.positions, gi = ground.mesh.indices;
      for (let k = 0; k < gi.length; k += 3) {
        const [a, b, c] = [gi[k] * 3, gi[k + 1] * 3, gi[k + 2] * 3];
        const ux = gp[b] - gp[a], uy = gp[b + 1] - gp[a + 1], uz = gp[b + 2] - gp[a + 2], vx = gp[c] - gp[a], vy = gp[c + 1] - gp[a + 1], vz = gp[c + 2] - gp[a + 2];
        const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
        (Math.abs(nz) < GROUND.steepNormalZ * Math.hypot(nx, ny, nz) ? steep : flat).push(gi[k], gi[k + 1], gi[k + 2]);
      }
      this.groundParts.push({ mesh: { positions: gp, indices: flat }, stride: 3, rgb: () => floor }, { mesh: { positions: gp, indices: steep }, stride: 3, rgb: () => tone.map((v) => v * STRUCTURES.sideShade) },
        { mesh: ground.apron, stride: 3, rgb: () => outside }, { mesh: ground.skirt, stride: 3, rgb: () => outside });
      ground.foundations.forEach((fromM, k) => {
        if (fromM === null) return;
        const b = buildings[k];
        const { mesh } = solidMesh({ id: '', file: '', role: 'box', type: 'foundation', polygon: b.polygon, bottomM: fromM, topM: b.baseM, estimated: true, props: {} });
        const own = b.plinth ? css(b.plinth) : tone; // Z09: the base of a building that names its plinth colour
        this.groundParts.push({ mesh, stride: SOLID_STRIDE, rgb: (i, at) => own.map((v) => v * at[i * SOLID_STRIDE + 3]) });
      });
    }

    this.structureParts = [];
    this.edges = [];
    const below = this.ground ? (x: number, y: number) => this.ground!.height(x, y) - 0.2 : undefined;
    for (const solid of shown) {
      const colors = solidColors(solid);
      const body = css(colors.body), top = css(colors.top);
      const pick: StructurePick = { kind: 'structure', id: solid.id };
      const polygons = this.platformPolygons.get(solid);
      // a platform: sides and underside here, the top in pieces below (road colours where a road or an area lies on it).
      // No side face where a neighbouring platform stands at least as high: the face is inside that neighbour.
      const inNeighbour = (x: number, y: number, z: number) => platforms.some((o) => o !== solid && o.bottomM < z && topHeight(o)(x, y) >= z - 0.01 && this.platformPolygons.get(o)!.some((p) => polygonContains(x, y, p)));
      const { mesh, edges } = solidMesh(solid, polygons ? { polygons, bottomAt: below, top: false, hiddenSide: inNeighbour } : {});
      this.structureParts.push({ mesh, stride: SOLID_STRIDE, pick, rgb: (i, at) => (at[i * SOLID_STRIDE + 4] ? top : body.map((v) => v * at[i * SOLID_STRIDE + 3])), pattern: polygons ? undefined : STRUCTURES.boxPatterns[String(solid.props?.pattern ?? '')] });
      if (STRUCTURES.outlined.includes(solid.type)) for (const e of edges) this.edges.push({ points: e, rgb: body.map((v) => v * STRUCTURES.outlineShade) });
      if (!polygons) continue;
      const whole = polygons.reduce((sum, q) => sum + polygonArea(q), 0);
      let covered = this.drawnSurfaces.covered.map((c) => ({ rgb: css(c.color), pattern: c.pattern ?? 0, polygons: polygonOps('both', polygons, c.polygons) }))
        .map((c) => ({ ...c, share: c.polygons.reduce((sum, q) => sum + polygonArea(q), 0) / (whole || 1) })).filter((c) => c.polygons.length);
      // one material over (nearly) the whole platform: the same surface, so the platform top is that material, with the platform's own outline
      const same = covered.find((c) => c.share >= PRECEDENCE.sameSurfaceShare);
      if (same) covered = covered.filter((c) => c !== same && c.share < same.share);
      const plain = covered.length ? polygonOps('minus', polygons, covered.flatMap((c) => c.polygons)) : polygons;
      // Z09: a plain paving platform (a forecourt, a terrace) is block paving like the pedestrian-priority ways
      const own = solid.material === 'paving' ? STRUCTURES.pavingPattern : 0;
      for (const part of [{ rgb: same?.rgb ?? top, pattern: same?.pattern ?? own, polygons: plain }, ...covered]) {
        const piece = topMesh(solid, part.polygons);
        if (piece.indices.length) this.structureParts.push({ mesh: piece, stride: 3, pick, rgb: () => part.rgb, pattern: part.pattern });
      }
    }
  }

  private position(x: number, y: number, z: number) {
    const { latitude, longitude } = tmInverse(x, y);
    return (window as any).Cesium.Cartesian3.fromDegrees(longitude, latitude, z);
  }

  private instance(d: Drawable) {
    const C = (window as any).Cesium;
    const n = d.mesh.positions.length / d.stride;
    const values = new Float64Array(n * 3);
    const colors = new Uint8Array(n * 4);
    for (let i = 0; i < n; i++) {
      const c = this.position(d.mesh.positions[i * d.stride], d.mesh.positions[i * d.stride + 1], d.mesh.positions[i * d.stride + 2]);
      values.set([c.x, c.y, c.z], i * 3);
      colors.set([...d.rgb(i, d.mesh.positions), 255], i * 4);
    }
    return new C.GeometryInstance({
      geometry: new C.Geometry({
        attributes: {
          position: new C.GeometryAttribute({ componentDatatype: C.ComponentDatatype.DOUBLE, componentsPerAttribute: 3, values }),
          color: new C.GeometryAttribute({ componentDatatype: C.ComponentDatatype.UNSIGNED_BYTE, componentsPerAttribute: 4, normalize: true, values: colors }),
          paving: pavingAttribute(C, d.mesh.positions, d.stride, d.pattern ?? 0),
        } as any,
        indices: new Uint32Array(d.mesh.indices),
        primitiveType: C.PrimitiveType.TRIANGLES,
        boundingSphere: C.BoundingSphere.fromVertices(values as unknown as number[]),
      }),
      id: d.pick,
    });
  }

  /** One unlit primitive of all the drawables that have anything left after the cut. */
  private addMeshes(parts: Drawable[], pickable: boolean) {
    const C = (window as any).Cesium;
    const plane = this.section;
    const instances = parts.map((d) => (plane ? { ...d, mesh: clipMesh(plane, d.mesh, d.stride) } : d)).filter((d) => d.mesh.indices.length).map((d) => this.instance(d));
    if (!instances.length) return;
    this.prims.add(new C.Primitive({
      geometryInstances: instances,
      appearance: pavingAppearance(C),
      asynchronous: false,
      allowPicking: pickable && this.src.pickable !== false,
    }));
  }

  private draw() {
    const C = (window as any).Cesium;
    this.prims.removeAll();
    // the terrain is not drawn inside the campus region (ground on), nor inside a platform (structures on)
    const cleared = this.visible.ground && this.ground !== null;
    setTerrainClip(this.viewer, 'campus-ground', cleared ? this.ground!.clip.map((p) => p[0].map(([x, y]) => this.position(x, y, 0))) : []);
    this.src.campusTint?.(!cleared);
    setTerrainClip(this.viewer, 'structures', this.visible.structures ? [...this.platformPolygons.keys()].map((s) => s.polygon[0].map(([x, y]) => this.position(x, y, 0))) : []);

    this.addMeshes(this.groundParts, false);
    this.addMeshes(this.structureParts, true);
    const plane = this.section;
    if (this.edges.length) {
      const lines = new C.PolylineCollection();
      for (const e of this.edges) {
        for (const piece of plane ? clipPolyline(plane, e.points) : [e.points]) {
          lines.add({ positions: piece.map((p) => this.position(p[0], p[1], p[2] + 0.02)), width: 1, material: C.Material.fromType('Color', { color: C.Color.fromBytes(e.rgb[0], e.rgb[1], e.rgb[2], 150) }) });
        }
      }
      this.prims.add(lines);
    }
    if (plane && this.visible.structures) this.drawCutFaces(plane);
    else if (this.underground && this.visible.structures && !this.walkInside) this.drawVoids();
    this.viewer.scene.requestRender?.();
  }

  /**
   * U04: the boxes marked `underground: true` (floor markings of an underground storey: the stall blocks and bay lines
   * of the car park under the field) as triangles (x, y, z) with their colour and top height. The road surface layer
   * draws them with the underground ways, between the underground floors in height order (scene-layers.ts passes them on).
   */
  undergroundMarks(): { mesh: { positions: number[]; indices: number[] }; css: string; z: number }[] {
    if (!this.visible.structures) return [];
    return this.solids.filter((s) => s.role === 'box' && s.props.underground === true).map((s) => {
      const { mesh } = solidMesh(s);
      const positions: number[] = [];
      for (let i = 0; i < mesh.positions.length; i += SOLID_STRIDE) positions.push(mesh.positions[i], mesh.positions[i + 1], mesh.positions[i + 2]);
      return { mesh: { positions, indices: mesh.indices }, css: solidColors(s).body, z: s.topM };
    });
  }

  /** The voids as boxes that show through the ground and the platforms, like the underground ways. */
  private drawVoids() {
    const C = (window as any).Cesium;
    const color = C.Color.fromCssColorString(STRUCTURES.void);
    const instances = this.solids.filter((s) => s.role === 'void').map((s) => {
      const { mesh } = solidMesh(s);
      const n = mesh.positions.length / SOLID_STRIDE;
      const values = new Float64Array(n * 3);
      for (let i = 0; i < n; i++) { const c = this.position(mesh.positions[i * SOLID_STRIDE], mesh.positions[i * SOLID_STRIDE + 1], mesh.positions[i * SOLID_STRIDE + 2]); values.set([c.x, c.y, c.z], i * 3); }
      return new C.GeometryInstance({
        geometry: new C.Geometry({
          attributes: { position: new C.GeometryAttribute({ componentDatatype: C.ComponentDatatype.DOUBLE, componentsPerAttribute: 3, values }) } as any,
          indices: new Uint32Array(mesh.indices), primitiveType: C.PrimitiveType.TRIANGLES, boundingSphere: C.BoundingSphere.fromVertices(values as unknown as number[]),
        }),
        id: { kind: 'structure', id: s.id } satisfies StructurePick,
        attributes: { color: C.ColorGeometryInstanceAttribute.fromColor(color), depthFailColor: C.ColorGeometryInstanceAttribute.fromColor(color.withAlpha(0.45)) },
      });
    });
    if (!instances.length) return;
    this.prims.add(new C.Primitive({
      geometryInstances: instances,
      appearance: new C.PerInstanceColorAppearance({ flat: true, translucent: false, closed: false }),
      depthFailAppearance: new C.PerInstanceColorAppearance({ flat: true, translucent: true, closed: false }),
      asynchronous: false, allowPicking: this.src.pickable !== false,
    }));
  }

  /**
   * F09: what the section plane cuts, for the cut face of section-layer.ts (outlines and name tags): each solid with
   * the polygons of its cut face ([distance from A, height] points), and each void as a rectangle per stretch.
   * `name`: what it is called on the face (STRUCTURES.sectionLabels, a void's own name), null for the rest.
   */
  cutItems(plane: SectionPlane): CutItem[] {
    const voids = this.solids.filter((s) => s.role === 'void');
    const items: CutItem[] = [];
    if (!this.visible.structures) return items;
    for (const solid of this.solids) {
      if (solid.role === 'void') continue;
      const inside = voids.filter((v) => solid.role === 'platform' && (v.props.inside === undefined || v.props.inside === solid.id));
      const polygons = sectionCaps(plane, solid, inside, this.platformPolygons.get(solid) ?? [solid.polygon]);
      const points = polygons.flat(2);
      if (!points.length) continue;
      const from = Math.min(...points.map((p) => p[0])), to = Math.max(...points.map((p) => p[0]));
      const [x, y] = planePoint(plane, (from + to) / 2);
      items.push({ solid, polygons, from, to, topM: topHeight(solid)(x, y), bottomM: solid.bottomM, name: STRUCTURES.sectionLabels[solid.role === 'platform' ? 'platform' : solid.type] ?? null });
    }
    for (const v of voids) for (const [from, to] of polygonIntervals(plane, v.polygon)) {
      items.push({ solid: v, polygons: [[[[from, v.bottomM], [to, v.bottomM], [to, v.topM], [from, v.topM]]]], from, to, topM: v.topM, bottomM: v.bottomM, name: voidName(v) });
    }
    return items;
  }

  /**
   * The faces the section plane cuts through the solids, filled in a darker tone of their colour, just in front of the
   * cut ground of section-layer.ts. A void inside a platform is a hole in that face, drawn in the background colour.
   * Their outlines and names are drawn by section-layer.ts from cutItems() (F09: one layout for every tag of the face).
   */
  private drawCutFaces(plane: SectionPlane) {
    const C = (window as any).Cesium;
    const parts: Drawable[] = [];
    const face = (polygons: Polygon[], rgb: number[], off: number) => {
      const { points, indices } = fillPolygons(polygons);
      const positions = points.flatMap(([d, z]) => { const [x, y] = planePoint(plane, d, off); return [x, y, z]; });
      if (indices.length) parts.push({ mesh: { positions, indices }, stride: 3, rgb: () => rgb });
    };
    for (const item of this.cutItems(plane)) {
      const solid = item.solid;
      if (solid.role === 'void') face(item.polygons, css(STRUCTURES.voidFace), 0.01);
      // a box that stands inside a void (`inVoid`: the columns and the ramp of a basement) is drawn in front of the void's face
      else face(item.polygons, css(solidColors(solid).body).map((v) => v * 0.8), solid.role === 'box' && solid.props?.inVoid === true ? 0.005 : 0.03);
    }
    // not cut again: the faces lie in the plane
    const instances = parts.map((d) => this.instance(d));
    if (instances.length) this.prims.add(new C.Primitive({ geometryInstances: instances, appearance: pavingAppearance(C), asynchronous: false, allowPicking: false }));
  }

  /** What the detail panel shows for a structure: name, kind, heights, evidence grade (estimated ones marked). */
  describe(id: string): { title: string; rows: [string, string][] } | null {
    const all = this.solids.filter((s) => s.id === id);
    const s = all[0];
    if (!s) return null;
    const p = s.props;
    const text = (v: unknown) => (v === undefined || v === null ? '–' : String(v));
    const kind: Record<string, string> = { platform: '기단(땅 덩어리)', void: '빈 곳(지하 공간)', stair_step: '계단 단', landing: '참·바닥', planter: '화단', wall: '벽·옹벽·난간', deck: '데크(뜬 판)', canopy: '차양·지붕', barrier: '차단기' };
    const top = topHeight(s);
    const heights = s.profile
      ? `윗면 ${Math.min(...s.profile.points.map((q) => q[1])).toFixed(2)} → ${s.topM.toFixed(2)} m (기운 면), 바닥 ${s.bottomM.toFixed(2)} m`
      : `윗면 ${top(0, 0).toFixed(2)} m, 아래 ${s.bottomM.toFixed(2)} m (높이 ${(s.topM - s.bottomM).toFixed(2)} m)`;
    const rows: [string, string][] = [
      ['종류', `${kind[s.type] ?? s.type}${s.material ? ` · ${s.material}` : ''}${s.stair ? ` · ${s.stair} (${this.solids.filter((o) => o.stair === s.stair).length}단)` : ''}`],
      ['높이', heights],
      ['근거 등급', `${text(p.grade)}${s.estimated && !String(p.grade ?? '').includes('추정') ? ' · 추정 포함' : ''}`],
    ];
    if (num(p.riseM) || num(p.runM) || num(p.widthM)) rows.push(['단 치수', `한 단 ${text(p.riseM)} m · 디딤 ${text(p.runM)} m · 폭 ${text(p.widthM)} m`]);
    if (p.basePlane) rows.push(['얹힌 면', text(p.basePlane)]);
    if (p.bottomNote) rows.push(['바닥', text(p.bottomNote)]);
    if (p.assumption) rows.push(['가정', text(p.assumption)]);
    rows.push(['근거', text(p.source)], ['파일', s.file]);
    return { title: `${s.estimated ? '(추정) ' : ''}${id}`, rows };
  }
}

const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
