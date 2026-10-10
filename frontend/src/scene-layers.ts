// The map layers the preview (main.ts) and the editor (editor-main.ts) share, mounted on their Cesium viewer:
// the merged road / area surfaces (road-surface-layer.ts) and the cross-section tool (section-layer.ts).
// A page gives the data (setData): the preview reads the public endpoints (loadPublicLayerData), the editor passes
// its own in-memory snapshot (scene-layer-data.ts), so unsaved edits show too.
// A further layer (e.g. stairs and walls from a structures file) joins through addLayer(): it is then cut by the
// cross-section on both pages.
import { api, type TerrainGrid } from './api';
import { sampler, type CampusSceneLayer } from './campus-map';
import { RoadSurfaceLayer, type RoadSurfacePart } from './road-surface-layer';
import { layerDataKey, type LayerData } from './scene-layer-data';
import { SectionTool, type Cuttable } from './section-layer';
import type { Viewer } from './vworld';

export type SceneLayersOptions = {
  grid: TerrainGrid;
  scene: CampusSceneLayer | null;
  /** Which surface parts show at first (default: all but the underground ways). */
  visible?: Partial<Record<RoadSurfacePart, boolean>>;
  /** false: clicks go through the surfaces. */
  pickable?: boolean;
  /** Which entities the cross-section cuts (section-layer.ts `objects`); default: all. */
  sectionObjects?: (entity: any) => boolean;
};

export class SceneLayers {
  readonly surfaces: RoadSurfaceLayer;
  readonly section: SectionTool;
  /** Called with the status text of the cross-section whenever it changes (bindLayerControls sets it). */
  onSectionStatus: (text: string) => void = () => undefined;
  private data: LayerData = { roads: [], areas: [] };
  private key = '';
  private readonly extra: (() => Cuttable | null)[] = [];

  constructor(viewer: Viewer, options: SceneLayersOptions) {
    const g = options.grid;
    const buildings = () => options.scene?.scene.buildings ?? [];
    this.surfaces = new RoadSurfaceLayer(viewer, { ground: sampler(g), buildings, visible: options.visible, pickable: options.pickable });
    this.section = new SectionTool(viewer, {
      height: sampler(g),
      box: { minX: g.originX, minY: g.originY, maxX: g.originX + g.width * g.resolution, maxY: g.originY + g.height * g.resolution },
      buildings,
      roads: () => this.data.roads,
      surfaces: () => this.surfaces.surfaces(),
      areas: () => this.data.areas,
      layers: () => [options.scene, this.surfaces, ...this.extra.map((get) => get())],
      objects: options.sectionObjects,
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
    this.section.refresh();
  }

  setVisible(part: RoadSurfacePart, visible: boolean) {
    this.surfaces.setVisible(visible, part);
    this.section.refresh(); // the cut face marks the surfaces that are shown
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
  layers.onSectionStatus = (text) => {
    controls.sectionStatus.textContent = text;
    controls.sectionTools.hidden = !layers.section.active;
  };
  controls.section.addEventListener('change', () => (controls.section.checked ? layers.section.start() : layers.section.stop()));
  controls.sectionLook.addEventListener('click', () => layers.section.lookAt());
  controls.sectionFlip.addEventListener('click', () => layers.section.flip());
}
