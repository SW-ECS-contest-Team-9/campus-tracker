// The map layers the preview (main.ts) and the editor (editor-main.ts) share, mounted on their Cesium viewer:
// the merged road / area surfaces (road-surface-layer.ts) and the cross-section tool (section-layer.ts).
// A page gives the data (setData): the preview reads the public endpoints (loadPublicLayerData), the editor passes
// its own in-memory snapshot (scene-layer-data.ts), so unsaved edits show too.
// The structures and the neutral campus ground (structures-layer.ts) are part of it too: the road surfaces are built
// around the structures (sync), and the cross-section cuts all of them.
// A further layer joins through addLayer(): it is then cut by the cross-section on both pages.
import { api, type TerrainGrid } from './api';
import { sampler, type CampusSceneLayer } from './campus-map';
import { RoadSurfaceLayer, type RoadSurfacePart } from './road-surface-layer';
import { layerDataKey, type LayerData } from './scene-layer-data';
import { SectionTool, type Cuttable } from './section-layer';
import { StructuresLayer, type StructurePart } from './structures-layer';
import type { Viewer } from './vworld';

export type SceneLayersOptions = {
  grid: TerrainGrid;
  scene: CampusSceneLayer | null;
  /** Which surface parts show at first (default: all but the underground ways). */
  visible?: Partial<Record<RoadSurfacePart, boolean>>;
  /** Whether the structures and the neutral campus ground show at first (default: both). */
  structures?: Partial<Record<StructurePart, boolean>>;
  /** Shows or hides the ivory campus area of the ground texture (initCampusMap gives it): hidden while the campus ground is drawn instead of the terrain. */
  campusTint?: (show: boolean) => void;
  /** Called after the structures or the ground changed (a page redraws what depends on them). */
  onStructures?: () => void;
  /** false: clicks go through the surfaces. */
  pickable?: boolean;
  /** Which entities the cross-section cuts (section-layer.ts `objects`); default: all. */
  sectionObjects?: (entity: any) => boolean;
  /** F09: called after a cut was set, changed or removed (the page hides its own name tags; the editor its edit lines). */
  onSection?: () => void;
  /** F09: the label of the switch in the section panel that shows the page's own lines again while a cut is on (the editor). */
  sectionOverlayLabel?: string;
};

export class SceneLayers {
  readonly surfaces: RoadSurfaceLayer;
  readonly structures: StructuresLayer;
  readonly section: SectionTool;
  /** Called with the status text of the cross-section whenever it changes (bindLayerControls sets it). */
  onSectionStatus: (text: string) => void = () => undefined;
  private data: LayerData = { roads: [], areas: [] };
  private key = '';
  private readonly extra: (() => Cuttable | null)[] = [];

  constructor(viewer: Viewer, private readonly options: SceneLayersOptions) {
    const g = options.grid;
    const buildings = () => options.scene?.scene.buildings ?? [];
    // before the road surfaces: the underground ways show through whatever was added to the scene before them
    this.structures = new StructuresLayer(viewer, { terrain: sampler(g), buildings, campus: () => options.scene?.scene.campus ?? [], visible: options.structures, pickable: options.pickable, campusTint: options.campusTint });
    this.surfaces = new RoadSurfaceLayer(viewer, { ground: sampler(g), buildings, visible: options.visible, pickable: options.pickable });
    this.structures.setUnderground(this.surfaces.isVisible('underground'));
    this.section = new SectionTool(viewer, {
      height: (x, y) => this.structures.groundAt(x, y), // the ground as drawn: the neutral surface inside the campus
      box: { minX: g.originX, minY: g.originY, maxX: g.originX + g.width * g.resolution, maxY: g.originY + g.height * g.resolution },
      buildings,
      roads: () => this.data.roads,
      surfaces: () => this.surfaces.surfaces(),
      areas: () => this.data.areas,
      layers: () => [options.scene, this.structures, this.surfaces, ...this.extra.map((get) => get())],
      objects: options.sectionObjects,
      cutItems: (plane) => this.structures.cutItems(plane),
      onChange: () => options.onSection?.(),
      overlayToggleLabel: options.sectionOverlayLabel,
    }, (text) => this.onSectionStatus(text));
  }

  /** Another layer the cross-section cuts (given as a getter: it may not exist yet). */
  addLayer(layer: () => Cuttable | null) {
    this.extra.push(layer);
  }

  /** New roads and areas; nothing happens when they are the same as before. */
  setData(data: LayerData) {
    const key = layerDataKey(data);
    if (key === this.key) return;
    this.key = key;
    this.data = data;
    this.surfaces.setData(data.roads, data.areas);
    this.sync();
  }

  /** The first-person walk went inside (underground, indoors) or came out: see the two layers' setWalkInside. */
  setWalkInside(inside: boolean) {
    this.structures.setWalkInside(inside);
    this.surfaces.setWalkInside(inside);
  }

  setVisible(part: RoadSurfacePart, visible: boolean) {
    this.surfaces.setVisible(visible, part);
    if (part === 'underground') this.structures.setUnderground(visible);
    else this.sync(); // the neutral ground fills what a hidden surface leaves
    this.section.refresh(); // the cut face marks the surfaces that are shown
  }

  setStructuresVisible(part: StructurePart, visible: boolean) {
    this.structures.setVisible(part, visible);
    this.sync();
  }

  /** Reads the structure files, then draws (a page calls this once; without it the layer stays empty). */
  async loadStructures() {
    await this.structures.load();
    this.sync();
  }

  /**
   * Structures and road surfaces depend on each other in this order: the road surfaces are built around the
   * structures (structures.ts PRECEDENCE), then the structures layer colours the platform tops with the roads on them
   * and stretches the neutral ground between everything that is drawn.
   */
  private sync() {
    this.surfaces.setContext(this.structures.context());
    this.surfaces.setUndergroundMarks(this.structures.undergroundMarks());
    this.structures.setSurfaces(this.surfaces.drawn());
    this.section.refresh();
    this.options.onStructures?.();
  }
}

/** The roads and areas anyone may read (the preview's data). */
export async function loadPublicLayerData(): Promise<LayerData> {
  const [roads, mobility] = await Promise.all([api.roads(), api.mobility()]);
  return { roads: roads.roads, areas: mobility.openAreas };
}

export type LayerControls = {
  /** Checkboxes per surface part (a page may leave one out and drive that part itself). */
  parts: Partial<Record<RoadSurfacePart, HTMLInputElement>>;
  /** Checkboxes of the structures and of the neutral campus ground. */
  structures?: Partial<Record<StructurePart, HTMLInputElement>>;
  section: HTMLInputElement;
  /** Shown while a cut is set: holds the two buttons. */
  sectionTools: HTMLElement;
  sectionLook: HTMLElement;
  sectionFlip: HTMLElement;
  sectionStatus: HTMLElement;
};

/** Wires a page's checkboxes and buttons to the layers (same behaviour on both pages). */
export function bindLayerControls(layers: SceneLayers, controls: LayerControls) {
  for (const [part, input] of Object.entries(controls.parts) as [RoadSurfacePart, HTMLInputElement][]) {
    input.checked = layers.surfaces.isVisible(part);
    input.addEventListener('change', () => layers.setVisible(part, input.checked));
  }
  for (const [part, input] of Object.entries(controls.structures ?? {}) as [StructurePart, HTMLInputElement][]) {
    input.checked = layers.structures.isVisible(part);
    input.addEventListener('change', () => layers.setStructuresVisible(part, input.checked));
  }
  layers.onSectionStatus = (text) => {
    controls.sectionStatus.textContent = text;
    controls.sectionTools.hidden = !layers.section.active;
  };
  controls.section.addEventListener('change', () => (controls.section.checked ? layers.section.start() : layers.section.stop()));
  controls.sectionLook.addEventListener('click', () => layers.section.lookAt());
  controls.sectionFlip.addEventListener('click', () => layers.section.flip());
}
