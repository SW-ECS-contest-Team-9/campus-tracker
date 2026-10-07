// Top-down map picture for an agent to look at its own work (docs/EDITOR_MCP_PLAN.md P4): plain SVG, north up, meters.
import type { XYZ } from '../editor/topology.js';

export interface MapScene {
  bbox: [number, number, number, number];
  buildings: { name: string | null; rings: number[][][] }[];
  roads: { id: string; name: string | null; roadClass: string; status: string; coordinates: XYZ[]; highlighted?: boolean; displayColor?: string | null }[];
  nodes: { kind: string; coordinate: XYZ; degree: number }[];
  places: { name: string; coordinate: XYZ }[];
  tracks: { label: string; points: [number, number][] }[];
  marks: { label?: string; coordinates: XYZ[] }[];
}

const COLORS: Record<string, string> = { pedestrian: '#0b8f70', vehicle: '#dc6a24', shared: '#7856b7' };
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/** A round scale-bar length (1/2/5 × 10^n meters) close to a fifth of the map width. */
function scaleBar(widthM: number) {
  const target = widthM / 5, pow = 10 ** Math.floor(Math.log10(target));
  return [1, 2, 5, 10].map((m) => m * pow).reduce((best, v) => (Math.abs(v - target) < Math.abs(best - target) ? v : best));
}

export function renderMapSvg(scene: MapScene, widthPx: number, labels: boolean): { svg: string; widthPx: number; heightPx: number; metersPerPixel: number } {
  const [minX, minY, maxX, maxY] = scene.bbox;
  const scale = widthPx / (maxX - minX);
  const heightPx = Math.max(1, Math.round((maxY - minY) * scale));
  const px = (x: number) => ((x - minX) * scale).toFixed(1);
  const py = (y: number) => ((maxY - y) * scale).toFixed(1); // north up
  const line = (c: ArrayLike<number>[]) => c.map((p) => `${px(p[0])},${py(p[1])}`).join(' ');
  const text = (x: number, y: number, s: string, size = 11, fill = '#1f2937') =>
    `<text x="${px(x)}" y="${py(y)}" dx="6" dy="-5" font-size="${size}" font-family="sans-serif" fill="${fill}" stroke="#ffffff" stroke-width="3" paint-order="stroke">${esc(s.slice(0, 40))}</text>`;
  const out: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${widthPx}" height="${heightPx}" viewBox="0 0 ${widthPx} ${heightPx}">`,
    `<rect width="100%" height="100%" fill="#f3efe0"/>`,
  ];
  for (const b of scene.buildings) {
    out.push(`<path d="${b.rings.map((r) => `M${r.map((p) => `${px(p[0])} ${py(p[1])}`).join('L')}Z`).join('')}" fill="#dcd9d2" stroke="#a8a29e" stroke-width="1" fill-rule="evenodd"/>`);
    if (labels && b.name && b.rings[0]) {
      const ring = b.rings[0], cx = ring.reduce((s, p) => s + p[0], 0) / ring.length, cy = ring.reduce((s, p) => s + p[1], 0) / ring.length;
      out.push(`<text x="${px(cx)}" y="${py(cy)}" font-size="10" font-family="sans-serif" fill="#6b7280" text-anchor="middle">${esc(b.name.slice(0, 24))}</text>`);
    }
  }
  for (const t of scene.tracks) out.push(`<polyline points="${line(t.points)}" fill="none" stroke="#64748b" stroke-width="1.5" stroke-dasharray="4 3"/>`);
  for (const r of scene.roads) {
    if (r.highlighted) out.push(`<polyline points="${line(r.coordinates)}" fill="none" stroke="#facc15" stroke-width="11" stroke-linecap="round" stroke-linejoin="round"/>`);
    out.push(`<polyline points="${line(r.coordinates)}" fill="none" stroke="#14251d" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/>`,
      `<polyline points="${line(r.coordinates)}" fill="none" stroke="${r.displayColor ?? COLORS[r.roadClass] ?? '#64748b'}" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"${r.status === 'DRAFT' ? '' : ' stroke-opacity="1"'}/>`);
  }
  for (const n of scene.nodes) {
    // Dead ends are hollow so missing connections stand out.
    const r = n.degree >= 3 ? 5 : 3.5;
    out.push(`<circle cx="${px(n.coordinate[0])}" cy="${py(n.coordinate[1])}" r="${r}" fill="${n.degree === 1 ? '#ffffff' : n.degree >= 3 ? '#ffca45' : '#192c25'}" stroke="#14251d" stroke-width="1.5"/>`);
  }
  if (labels) for (const r of scene.roads) {
    const mid = r.coordinates[Math.floor(r.coordinates.length / 2)];
    out.push(text(mid[0], mid[1], r.name || r.id.slice(0, 8), 10, r.highlighted ? '#92400e' : '#374151'));
  }
  for (const p of scene.places) {
    out.push(`<circle cx="${px(p.coordinate[0])}" cy="${py(p.coordinate[1])}" r="5" fill="#cc3f64" stroke="#ffffff" stroke-width="2"/>`);
    if (labels) out.push(text(p.coordinate[0], p.coordinate[1], p.name, 11, '#9d174d'));
  }
  for (const m of scene.marks) {
    if (m.coordinates.length > 1) out.push(`<polyline points="${line(m.coordinates)}" fill="none" stroke="#d946ef" stroke-width="3" stroke-dasharray="8 5"/>`);
    else out.push(`<circle cx="${px(m.coordinates[0][0])}" cy="${py(m.coordinates[0][1])}" r="9" fill="none" stroke="#d946ef" stroke-width="3"/>`);
    if (m.label) out.push(text(m.coordinates[0][0], m.coordinates[0][1], m.label, 12, '#86198f'));
  }
  const bar = scaleBar(maxX - minX), barPx = bar * scale;
  out.push(`<rect x="12" y="${heightPx - 30}" width="${(barPx + 16).toFixed(0)}" height="22" fill="#ffffff" fill-opacity="0.85"/>`,
    `<path d="M20 ${heightPx - 14}h${barPx.toFixed(1)}m0 -5v10M20 ${heightPx - 19}v10" stroke="#111827" stroke-width="2" fill="none"/>`,
    `<text x="${(20 + barPx / 2).toFixed(1)}" y="${heightPx - 18}" font-size="10" font-family="sans-serif" text-anchor="middle" fill="#111827">${bar} m</text>`,
    `<text x="${widthPx - 14}" y="20" font-size="13" font-family="sans-serif" text-anchor="end" fill="#111827">N ↑</text>`, '</svg>');
  return { svg: out.join(''), widthPx, heightPx, metersPerPixel: 1 / scale };
}
