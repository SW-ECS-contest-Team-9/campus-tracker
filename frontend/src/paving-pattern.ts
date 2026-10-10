// Z08: the unlit per-vertex-colour appearance of the road surfaces and the structures, with a subtle procedural
// joint pattern where a surface is paved with blocks or slabs. Each vertex carries `paving` = (x, y, kind): its plan
// position in metres from PAVING.origin (EPSG:5186) and which pattern its face has (0 = none; ROAD_SURFACE.patterns).
// The pattern is drawn in plan (world axes, not along the way) and fades out where a joint would be thinner than a
// pixel, so a far surface is one calm colour (no moire).
export const PAVING = {
  /** Plan origin the pattern coordinates are measured from (keeps them small enough for 32-bit floats). */
  origin: [201000, 557000],
  /** 1: paving blocks in running bond (length × width, m). 2: square slabs (side, m). */
  block: [0.6, 0.3],
  slab: 0.9,
  /** Joint width (m) and how much darker a joint is than the face (0..1). */
  jointM: 0.035,
  jointShade: 0.13,
};

const VS = `in vec3 position3DHigh;
in vec3 position3DLow;
in vec4 color;
in vec3 paving;
in float batchId;
out vec4 v_color;
out vec3 v_paving;
void main() {
    vec4 p = czm_computePosition();
    v_color = color;
    v_paving = paving;
    gl_Position = czm_modelViewProjectionRelativeToEye * p;
}`;

const FS = `in vec4 v_color;
in vec3 v_paving;
float jointLine(float v, float cell, float joint) {
    float w = max(fwidth(v), 1e-5);
    float d = abs(fract(v / cell + 0.5) - 0.5) * cell;
    return (1.0 - smoothstep(joint * 0.5, joint * 0.5 + w, d)) * clamp(joint / w, 0.0, 1.0);
}
void main() {
    vec3 c = v_color.rgb;
    float kind = floor(v_paving.z + 0.5);
    if (kind > 0.5) {
        vec2 cell = kind < 1.5 ? vec2(${PAVING.block[0].toFixed(3)}, ${PAVING.block[1].toFixed(3)}) : vec2(${PAVING.slab.toFixed(3)});
        float row = floor(v_paving.y / cell.y);
        float shift = kind < 1.5 ? mod(row, 2.0) * 0.5 * cell.x : 0.0;
        float j = max(jointLine(v_paving.y, cell.y, ${PAVING.jointM.toFixed(3)}), jointLine(v_paving.x + shift, cell.x, ${PAVING.jointM.toFixed(3)}));
        c *= 1.0 - ${PAVING.jointShade.toFixed(3)} * j;
    }
    out_FragColor = czm_gammaCorrect(vec4(c, 1.0));
}`;

/** The appearance (flat, opaque): a geometry drawn with it needs the attributes `color` and `paving`. */
export function pavingAppearance(C: any) {
  return new C.Appearance({ translucent: false, closed: false, vertexShaderSource: VS, fragmentShaderSource: FS, renderState: C.Appearance.getDefaultRenderState(false, false) });
}

/** The `paving` attribute of a mesh (x, y first in each vertex of `stride` numbers) whose faces all have one pattern kind. */
export function pavingAttribute(C: any, positions: number[], stride: number, kind: number) {
  const n = positions.length / stride;
  const values = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) values.set([positions[i * stride] - PAVING.origin[0], positions[i * stride + 1] - PAVING.origin[1], kind], i * 3);
  return new C.GeometryAttribute({ componentDatatype: C.ComponentDatatype.FLOAT, componentsPerAttribute: 3, values });
}
