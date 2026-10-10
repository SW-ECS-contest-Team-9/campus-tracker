// E01: 원 입력(등고선+표고점, 5186 변환본)으로 buildDem 을 다시 돌려 보관된 서버 격자와 비교한다.
// 사용법: npx tsx docs/audit/e01/rebuild_check.ts <sources-5186.json> <terrain-grid.f32> <terrain-grid-meta.json> [출력.f32]
import fs from 'node:fs';
import { buildDem, type Grid } from '../../../backend/src/geo/dem.ts';
const [src, gridFile, metaFile, out] = process.argv.slice(2);
const s = JSON.parse(fs.readFileSync(src, 'utf8'));
const m = JSON.parse(fs.readFileSync(metaFile, 'utf8').replace(/^\uFEFF/, ''));
const grid: Grid = { originX: m.originX, originY: m.originY, resolution: m.resolution, width: m.width, height: m.height };
const buf = fs.readFileSync(gridFile);
const live = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
const dem = buildDem(grid, s.contours, s.spots);
let max = 0, sq = 0, n05 = 0, n005 = 0;
const worst: any[] = [];
for (let i = 0; i < live.length; i++) {
  const d = dem.heights[i] - live[i];
  const a = Math.abs(d);
  sq += d * d;
  if (a > 0.05) n005++;
  if (a > 0.5) { n05++; worst.push({ x: grid.originX + (i % grid.width + 0.5) * 2, y: grid.originY + (Math.floor(i / grid.width) + 0.5) * 2, d: Math.round(d * 100) / 100 }); }
  if (a > max) max = a;
}
console.log(JSON.stringify({ cells: live.length, maxAbs: max, rms: Math.sqrt(sq / live.length), over005: n005, over05: n05 }));
console.log(JSON.stringify(worst.sort((a, b) => Math.abs(b.d) - Math.abs(a.d)).slice(0, 12)));
if (out) fs.writeFileSync(out, Buffer.from(dem.heights.buffer));
