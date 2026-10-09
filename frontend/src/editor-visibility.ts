type XYZ = [number, number, number];

/** Same projected-metre basis as WASD: 0 degrees north, 90 degrees east. */
export function cursorAxes(origin: XYZ, heading: number): { label: string; end: XYZ; color: string }[] {
  return [
    { label: '앞 W · 4m', turn: 0, color: '#ffffff' },
    { label: '우 D · 4m', turn: 90, color: '#4ad7ff' },
    { label: '뒤 S · 4m', turn: 180, color: '#ffcd65' },
    { label: '좌 A · 4m', turn: 270, color: '#4ad7ff' },
  ].map(({ label, turn, color }) => {
    const angle = (heading + turn) * Math.PI / 180;
    return { label, color, end: [origin[0] + 4 * Math.sin(angle), origin[1] + 4 * Math.cos(angle), origin[2]] as XYZ };
  });
}

export function xrayAlpha(alpha: number, dimmed: boolean, isolated: boolean) {
  return Math.min(0.99, isolated ? alpha : Math.max(alpha, dimmed ? 0.28 : 0.55));
}

export function xrayAppearance(C: any) {
  return new C.PolylineColorAppearance({ translucent: true, renderState: { depthTest: { enabled: false }, depthMask: false } });
}

type XrayPath = { id: string; positions: any[]; width: number; color: any };

/** Screen-width centreline overlay. Public render state avoids dependence on depth-fail support. */
export class XrayPaths {
  private C: any;
  private viewer: any;
  private primitive: any = null;
  private ids = new Map<string, { line: any; edge: any }>();

  constructor(C: any, viewer: any) { this.C = C; this.viewer = viewer; }

  replace(paths: XrayPath[]) {
    const C = this.C;
    if (this.primitive) this.viewer.scene.primitives.remove(this.primitive);
    this.primitive = null;
    this.ids.clear();
    const instances: any[] = [];
    for (const p of paths) {
      if (p.positions.length < 2) continue;
      const ids = { line: { id: `editor:road:${p.id}` }, edge: { id: `editor:road:${p.id}` } };
      this.ids.set(p.id, ids);
      for (const edge of [true, false]) instances.push(new C.GeometryInstance({
        id: edge ? ids.edge : ids.line,
        geometry: new C.PolylineGeometry({ positions: p.positions, width: p.width + (edge ? 3 : 0),
          arcType: C.ArcType.NONE, vertexFormat: C.PolylineColorAppearance.VERTEX_FORMAT }),
        attributes: { color: C.ColorGeometryInstanceAttribute.fromColor(edge ? C.Color.fromCssColorString('#14251d').withAlpha(0.75) : p.color) },
      }));
    }
    if (instances.length) this.primitive = this.viewer.scene.primitives.add(new C.Primitive({
      geometryInstances: instances, appearance: xrayAppearance(C), asynchronous: false,
    }));
  }

  setVisible(show: boolean) { if (this.primitive) this.primitive.show = show; }

  update(id: string, color: any, alpha: number) {
    if (!this.primitive?.ready) return;
    const ids = this.ids.get(id);
    if (!ids) return;
    const C = this.C;
    for (const edge of [true, false]) {
      const attributes = this.primitive.getGeometryInstanceAttributes(edge ? ids.edge : ids.line);
      const tint = edge ? C.Color.fromCssColorString('#14251d') : C.Color.clone(color);
      tint.alpha = alpha;
      attributes.color = C.ColorGeometryInstanceAttribute.toValue(tint, attributes.color);
    }
  }
}
