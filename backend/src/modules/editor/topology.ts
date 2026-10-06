export type XYZ = [number, number, number];
export type Hit = { x: number; y: number; z: number; sourceMeasure: number; otherMeasure: number; zDelta: number };

/** Nearest point and distance along a road in the campus XY plane. */
export function projectOnLine(points: XYZ[], target: XYZ) {
  let measure = 0;
  let best: { point: XYZ; measure: number; distance: number; total: number } | null = null;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i];
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const length = Math.hypot(dx, dy);
    const fraction = length > 0 ? Math.max(0, Math.min(1, ((target[0] - a[0]) * dx + (target[1] - a[1]) * dy) / (length * length))) : 0;
    const point: XYZ = [a[0] + dx * fraction, a[1] + dy * fraction, a[2] + (b[2] - a[2]) * fraction];
    const distance = Math.hypot(target[0] - point[0], target[1] - point[1]);
    if (!best || distance < best.distance) best = { point, measure: measure + length * fraction, distance, total: 0 };
    measure += length;
  }
  if (best) best.total = measure;
  return best;
}

function segmentHit(a: XYZ, b: XYZ, c: XYZ, d: XYZ) {
  const rx = b[0] - a[0], ry = b[1] - a[1];
  const sx = d[0] - c[0], sy = d[1] - c[1];
  const den = rx * sy - ry * sx;
  if (Math.abs(den) < 1e-9) return null; // parallel/collinear overlap requires explicit user review
  const qx = c[0] - a[0], qy = c[1] - a[1];
  const t = (qx * sy - qy * sx) / den;
  const u = (qx * ry - qy * rx) / den;
  const eps = 1e-8;
  if (t < -eps || t > 1 + eps || u < -eps || u > 1 + eps) return null;
  const tc = Math.min(1, Math.max(0, t));
  const uc = Math.min(1, Math.max(0, u));
  return {
    x: a[0] + rx * tc,
    y: a[1] + ry * tc,
    sourceZ: a[2] + (b[2] - a[2]) * tc,
    otherZ: c[2] + (d[2] - c[2]) * uc,
    t: tc,
    u: uc,
  };
}

function segmentLengths(points: XYZ[]) {
  const lengths = [0];
  for (let i = 1; i < points.length; i++) lengths.push(Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]));
  return lengths;
}

/** Exact vertex coincidences also connect collinear roads, which segment crossing tests omit. */
export function coincidentVertices(source: XYZ[], other: XYZ[]): Hit[] {
  const sourceLengths = segmentLengths(source), otherLengths = segmentLengths(other);
  let sourceMeasure = 0;
  const hits: Hit[] = [];
  for (let i = 0; i < source.length; i++) {
    sourceMeasure += sourceLengths[i];
    let otherMeasure = 0;
    for (let j = 0; j < other.length; j++) {
      otherMeasure += otherLengths[j];
      if (Math.hypot(source[i][0] - other[j][0], source[i][1] - other[j][1]) > 0.02
        || Math.abs(source[i][2] - other[j][2]) > 0.05) continue;
      hits.push({ x: other[j][0], y: other[j][1], z: other[j][2], sourceMeasure, otherMeasure, zDelta: Math.abs(source[i][2] - other[j][2]) });
    }
  }
  return hits;
}

function locationAt(points: XYZ[], index: number, fraction: number) {
  const a = points[index], b = points[index + 1];
  return [a[0] + (b[0] - a[0]) * fraction, a[1] + (b[1] - a[1]) * fraction] as const;
}

function cumulativeMeasure(points: XYZ[], segment: number, fraction: number, lengths = segmentLengths(points)) {
  return lengths.slice(1, segment + 1).reduce((sum, n) => sum + n, 0) + lengths[segment + 1] * fraction;
}

/** 2D crossing candidates with each line's independently interpolated height. */
export function crossings(a: XYZ[], b: XYZ[], zToleranceM = 1.25): Hit[] {
  const al = segmentLengths(a), bl = segmentLengths(b);
  const hits: Hit[] = [];
  for (let i = 0; i < a.length - 1; i++) for (let j = 0; j < b.length - 1; j++) {
    const h = segmentHit(a[i], a[i + 1], b[j], b[j + 1]);
    if (!h || Math.abs(h.sourceZ - h.otherZ) > zToleranceM) continue;
    const p = locationAt(a, i, h.t);
    const m = cumulativeMeasure(a, i, h.t, al);
    const n = cumulativeMeasure(b, j, h.u, bl);
    if (hits.some((x) => Math.hypot(x.x - p[0], x.y - p[1]) < 0.01
      && Math.abs(x.sourceMeasure - m) < 0.01 && Math.abs(x.otherMeasure - n) < 0.01)) continue;
    hits.push({ x: p[0], y: p[1], z: (h.sourceZ + h.otherZ) / 2, sourceMeasure: m, otherMeasure: n, zDelta: Math.abs(h.sourceZ - h.otherZ) });
  }
  return hits.sort((x, y) => x.sourceMeasure - y.sourceMeasure);
}

/** Splits a line at XY measures and sets each cut's Z to the shared network node elevation. */
export function splitAt(points: XYZ[], cuts: { measure: number; x: number; y: number; z: number }[]): XYZ[][] {
  const lengths = segmentLengths(points);
  const total = lengths.reduce((sum, n) => sum + n, 0);
  const ordered = cuts.filter((c) => c.measure > 0.01 && c.measure < total - 0.01).sort((a, b) => a.measure - b.measure);
  const unique: typeof ordered = [];
  for (const cut of ordered) if (!unique.length || Math.abs(cut.measure - unique[unique.length - 1].measure) > 0.01) unique.push(cut);
  if (!unique.length) return [points.map((p) => [...p] as XYZ)];
  const vertices: { point: XYZ; measure: number; cut: boolean }[] = [{ point: [...points[0]] as XYZ, measure: 0, cut: false }];
  let measure = 0;
  for (let i = 1; i < points.length; i++) {
    measure += lengths[i];
    vertices.push({ point: [...points[i]] as XYZ, measure, cut: false });
  }
  for (const cut of unique) vertices.push({ point: [cut.x, cut.y, cut.z], measure: cut.measure, cut: true });
  vertices.sort((a, b) => a.measure - b.measure || Number(b.cut) - Number(a.cut));
  const orderedVertices: typeof vertices = [];
  for (const vertex of vertices) {
    const prior = orderedVertices.at(-1);
    if (prior && Math.abs(prior.measure - vertex.measure) < 0.005) {
      if (vertex.cut) orderedVertices[orderedVertices.length - 1] = vertex;
    } else orderedVertices.push(vertex);
  }
  const boundaries = [0, ...orderedVertices.flatMap((v, i) => v.cut && i > 0 && i < orderedVertices.length - 1 ? [i] : []), orderedVertices.length - 1];
  const groups: XYZ[][] = [];
  for (let i = 1; i < boundaries.length; i++) {
    const group = orderedVertices.slice(boundaries[i - 1], boundaries[i] + 1).map((v) => v.point);
    const cleaned = group.filter((p, j) => j === 0 || Math.hypot(p[0] - group[j - 1][0], p[1] - group[j - 1][1], p[2] - group[j - 1][2]) > 1e-8);
    if (cleaned.length >= 2 && cleaned.some((p, j) => j > 0 && Math.hypot(p[0] - cleaned[0][0], p[1] - cleaned[0][1]) > 0.05)) groups.push(cleaned);
  }
  return groups.filter((g) => g.length >= 2 && g.some((p, i) => i > 0 && Math.hypot(p[0] - g[0][0], p[1] - g[0][1]) > 0.05));
}
