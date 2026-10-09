import type * as Cesium from 'cesium';

type CesiumNS = typeof Cesium;
export type ElevationRange = { min: number; max: number };

/** Fixed for the loaded model, so zooming or selecting a building never changes the meaning of a colour. */
export function elevationRange(heights: Float32Array, buildings: { baseM: number; roofM: number }[]): ElevationRange {
  let min = Infinity, max = -Infinity;
  const include = (h: number) => {
    if (Number.isFinite(h)) { min = Math.min(min, h); max = Math.max(max, h); }
  };
  for (const h of heights) include(h);
  for (const b of buildings) { include(b.baseM); include(b.roofM); }
  if (!Number.isFinite(min)) return { min: 0, max: 10 };
  min = Math.floor(min / 10) * 10;
  return { min, max: Math.max(min + 10, Math.ceil(max / 10) * 10) };
}

/** Put rendered height in texture coordinates; retain the original mesh and picking IDs. */
export function colorizeGeometry(C: CesiumNS, geometry: Cesium.Geometry, range: ElevationRange): void {
  const positions = geometry.attributes.position!.values;
  const st = new Float32Array((positions.length / 3) * 2);
  const point = new C.Cartesian3();
  for (let i = 0; i < positions.length / 3; i++) {
    C.Cartesian3.fromElements(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2], point);
    const height = C.Cartographic.fromCartesian(point).height;
    st[i * 2] = (height - range.min) / (range.max - range.min);
    st[i * 2 + 1] = 0.5;
  }
  geometry.attributes.st = new C.GeometryAttribute({ componentDatatype: C.ComponentDatatype.FLOAT, componentsPerAttribute: 2, values: st });
}

/** One texture is shared by terrain, buildings and the visible legend. */
export function elevationRamp(): string {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 1;
  const ctx = canvas.getContext('2d')!;
  const ramp = ctx.createLinearGradient(0, 0, 256, 0);
  ['#440154', '#3b528b', '#21918c', '#5ec962', '#fde725'].forEach((color, i) => ramp.addColorStop(i / 4, color));
  ctx.fillStyle = ramp;
  ctx.fillRect(0, 0, 256, 1);
  // Material caches and clones its fabric. A data URL survives that clone; a canvas constructor does not.
  return canvas.toDataURL('image/png');
}

export function elevationMaterial(C: CesiumNS, image: string, range: ElevationRange, terrain: boolean, opacity = 1): Cesium.Material {
  return new C.Material({
    fabric: {
      type: terrain ? 'CampusTerrainElevation' : 'CampusBuildingElevation',
      uniforms: { image, minimumHeight: range.min, maximumHeight: range.max, opacity },
      source: `czm_material czm_getMaterial(czm_materialInput materialInput) {
        czm_material material = czm_getDefaultMaterial(materialInput);
        float heightFraction = ${terrain ? '(materialInput.height - minimumHeight) / (maximumHeight - minimumHeight)' : 'materialInput.st.s'};
        float sampleX = (0.5 + 255.0 * clamp(heightFraction, 0.0, 1.0)) / 256.0;
        vec4 color = czm_gammaCorrect(texture(image, vec2(sampleX, 0.5)));
        material.diffuse = color.rgb;
        material.alpha = opacity;
        return material;
      }`,
    },
    translucent: opacity < 1,
  });
}

export function elevationControl(container: HTMLElement, image: string, range: ElevationRange, onChange: (enabled: boolean) => void): void {
  const panel = document.createElement('div');
  panel.className = 'campus-elevation';
  panel.innerHTML = `<label class="campus-elevation-toggle"><input type="checkbox"> 고도 색상</label>
    <div class="campus-elevation-legend" hidden>
      <div>지형·건물 공통 고도 (m)</div>
      <img alt="낮은 고도는 보라색, 높은 고도는 노란색">
      <div class="campus-elevation-ticks"><span>${range.min}</span><span>${(range.min + range.max) / 2}</span><span>${range.max}</span></div>
      <small>현재 모델 기준 · 정표고</small>
    </div>`;
  panel.querySelector('img')!.src = image;
  const checkbox = panel.querySelector('input')!;
  checkbox.addEventListener('change', () => {
    panel.querySelector<HTMLElement>('.campus-elevation-legend')!.hidden = !checkbox.checked;
    onChange(checkbox.checked);
  });
  container.append(panel);
}
