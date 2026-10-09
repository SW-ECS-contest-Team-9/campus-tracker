// 계단 접속 검사(렌더 삼각형 기준). 앱과 같은 parseCorrections + Cesium PolygonGeometry(perPositionHeight)로 면을 삼각화하고,
// 질의 XY가 들어가는 삼각형의 무게중심 보간 z를 쓴다(면 사이 IDW 금지). 옵션 --fix-cut: 사잇길 절단 면의 새 경계 정점 z를
// 원 SF-CORRIDOR 렌더 z로 다시 써서 같은 면에서 보존한다.
// 사용: node --experimental-strip-types docs/audit/field/render_z_check.ts [--fix-cut]   (frontend 폴더 기준 경로 사용)
import fs from 'node:fs';
import { register } from 'node:module';
import * as C from 'cesium';

register('data:text/javascript,export async function resolve(s,c,n){try{return await n(s,c)}catch(e){if(s.startsWith(".")&&!s.endsWith(".ts"))return n(s+".ts",c);throw e}}', import.meta.url);
const ROOT = new URL('../../../', import.meta.url);
const { parseCorrections } = await import(new URL('frontend/src/scene-local-corrections.ts', ROOT).href);
const { tmInverse, tmForward } = await import(new URL('frontend/src/tm.ts', ROOT).href);
const DIR = new URL('frontend/public/corrections/', ROOT);
const read = (f: string) => JSON.parse(fs.readFileSync(new URL(f, DIR), 'utf8'));
const FIX = process.argv.includes('--fix-cut');

type Tri = { a: number[]; b: number[]; c: number[] }; // [x5186, y5186, h]
function triangles(f: any): Tri[] {
  const out: Tri[] = [];
  for (const poly of f.polygons) {
    const ring = (r: number[][]) => C.Cartesian3.fromDegreesArrayHeights(r.slice(0, -1).flat());
    const g = C.PolygonGeometry.createGeometry(new C.PolygonGeometry({
      polygonHierarchy: new C.PolygonHierarchy(ring(poly[0]), poly.slice(1).map((h: number[][]) => new C.PolygonHierarchy(ring(h)))),
      perPositionHeight: true, vertexFormat: C.VertexFormat.POSITION_ONLY,
    }));
    if (!g) continue;
    const pos = g.attributes.position.values as Float64Array;
    const idx = g.indices as Uint16Array | Uint32Array;
    const pts: number[][] = [];
    for (let i = 0; i < pos.length; i += 3) {
      const cg = C.Cartographic.fromCartesian(new C.Cartesian3(pos[i], pos[i + 1], pos[i + 2]));
      const t = tmForward(C.Math.toDegrees(cg.latitude), C.Math.toDegrees(cg.longitude));
      pts.push([t.x, t.y, cg.height]);
    }
    for (let i = 0; i < idx.length; i += 3) out.push({ a: pts[idx[i]], b: pts[idx[i + 1]], c: pts[idx[i + 2]] });
  }
  return out;
}
function zAt(tris: Tri[], x: number, y: number): number | null {
  for (const { a, b, c } of tris) {
    const d = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1]);
    if (Math.abs(d) < 1e-12) continue;
    const l1 = ((b[1] - c[1]) * (x - c[0]) + (c[0] - b[0]) * (y - c[1])) / d;
    const l2 = ((c[1] - a[1]) * (x - c[0]) + (a[0] - c[0]) * (y - c[1])) / d;
    const l3 = 1 - l1 - l2;
    if (l1 >= -1e-9 && l2 >= -1e-9 && l3 >= -1e-9) return l1 * a[2] + l2 * b[2] + l3 * c[2];
  }
  return null;
}
const lines: string[] = [];
const surf = (file: string, group: string) => parseCorrections(file, read(file), group).features.filter((f: any) => f.kind === 'surface');
const v3 = surf('field-surfaces-v3.geojson', 'corrected');
const T = new Map<string, Tri[]>(v3.map((f: any) => [f.id, triangles(f)]));

// 1) 사잇길 절단 면: 새 경계 정점 z를 원 면 렌더 z로(--fix-cut), 내부 삼각형 z 비교
// 사잇길 면 = corridor-surface-v4(내부 S-MAP 표본 TIN, 앱 Corrected에서 v3 SF-CORRIDOR 대체)
const v4f = parseCorrections('corridor-surface-v4.geojson', read('corridor-surface-v4.geojson'), 'corrected').features.find((f: any) => f.id === 'SF-CORRIDOR-V4');
const corridor = triangles(v4f);
const dumpIdx = process.argv.indexOf('--dump-tris');
if (dumpIdx > 0) { // 원 SF-CORRIDOR 렌더 삼각형(EPSG:5186 x,y,z)을 내보내 같은 삼각형으로 절단 면을 만들게 함(cut_from_render_tris.py)
  fs.writeFileSync(process.argv[dumpIdx + 1], JSON.stringify(corridor.map((t) => [t.a, t.b, t.c])), 'utf8');
  console.log(`dumped ${corridor.length} triangles`);
  process.exit(0);
}
const v4raw = read('corridor-surface-v4.geojson').features.find((f: any) => f.properties.id === 'SF-CORRIDOR-V4');
const origXY = new Set(v4raw.geometry.coordinates.flatMap((p: number[][][]) => p[0]).map((c: number[]) => `${c[0]},${c[1]}`));
// 표본 재현: TIN 꼭짓점(S-MAP 표본) 위치의 렌더 z = 표본 z
{ let n = 0, worst = 0; const seen = new Set<string>();
  for (const p of v4raw.geometry.coordinates) for (const c of p[0]) { const k = `${c[0]},${c[1]}`; if (seen.has(k)) continue; seen.add(k); const z = zAt(corridor, c[0], c[1]); if (z == null) continue; n++; worst = Math.max(worst, Math.abs(z - c[2])); }
  lines.push(`사잇길 v4 표본 재현(렌더 삼각형 z vs 표본 z): 표본 ${n}개, 최대 차 ${worst.toFixed(4)} m`); }
// 빈칸: 빈칸 다각형 안 점은 어느 사잇길 삼각형에도 들지 않아야 함(보간 없음)
{ const gaps = read('corridor-surface-v4.geojson').features.filter((f: any) => f.properties.type === 'gap_unverified');
  let inside = 0, tested = 0;
  for (const g of gaps) { const r = g.geometry.coordinates; const cx = r.slice(0, -1).reduce((s: number, c: number[]) => s + c[0], 0) / (r.length - 1), cy = r.slice(0, -1).reduce((s: number, c: number[]) => s + c[1], 0) / (r.length - 1); tested++; if (zAt(corridor, cx, cy) != null) inside++; }
  lines.push(`빈칸 ${tested}곳 중심점이 사잇길 렌더 삼각형 안: ${inside}곳 (0이어야 보간 없음; 오목 빈칸은 중심이 밖일 수 있어 참고값)`); }
for (const file of ['corridor-stair-cut-v1.geojson', 'stairs-v6-est.geojson']) {
  const fc = read(file);
  const cutF = fc.features.find((f: any) => f.properties.replaces === 'SF-CORRIDOR-V4');
  let changed = 0, miss = 0, maxFix = 0;
  for (const poly of cutF.geometry.coordinates) for (const ring of poly) for (const c of ring) {
    if (origXY.has(`${c[0]},${c[1]}`)) continue;
    const z = zAt(corridor, c[0], c[1]);
    if (z == null) { miss++; continue; }
    maxFix = Math.max(maxFix, Math.abs(z - c[2]));
    if (FIX && Math.abs(z - c[2]) > 1e-4) { c[2] = Math.round(z * 1000) / 1000; changed++; }
  }
  if (FIX) {
    cutF.properties.assumption = cutF.properties.assumption.replace(/새 구멍 가장자리 z는 원 정점 IDW|나머지 정점은 SF-CORRIDOR 원값/, (m: string) => m + '; 새 경계 정점 z = 원 SF-CORRIDOR 렌더 삼각형 무게중심 보간(같은 면, render_z_check.ts)');
    fs.writeFileSync(new URL(file, DIR), JSON.stringify(fc), 'utf8');
  }
  lines.push(`${file}: 새 경계 정점 z 원 면 렌더 z와 최대 차 ${maxFix.toFixed(3)} m${FIX ? `, ${changed}개 교체` : ''}, 원 면 밖 ${miss}`);
  const cutTris = triangles(parseCorrections(file, fc, file.startsWith('stairs') ? 'stairV6' : 'stairCandidate').features.find((f: any) => f.replaces === 'SF-CORRIDOR-V4'));
  // 내부 비교: 절단 면 삼각형 무게중심마다 원 면 렌더 z
  let n = 0, worst = 0;
  for (const { a, b, c } of cutTris) {
    const x = (a[0] + b[0] + c[0]) / 3, y = (a[1] + b[1] + c[1]) / 3, z = (a[2] + b[2] + c[2]) / 3;
    const zo = zAt(corridor, x, y);
    if (zo == null) continue;
    n++; worst = Math.max(worst, Math.abs(z - zo));
  }
  lines.push(`  내부 삼각형 ${n}개 무게중심: 절단 면 z − 원 면 렌더 z 최대 ${worst.toFixed(3)} m (삼각화가 달라 생기는 차, 0이 아니면 내부도 바뀜)`);
}

// 2) 계단 접속: v6 후보 기준 렌더 z(보이는 면 = 절단 사잇길 + 나머지 v3 보행면, 지붕 제외)
const v6 = read('stairs-v6-est.geojson');
const cut6 = triangles(parseCorrections('stairs-v6-est.geojson', v6, 'stairV6').features.find((f: any) => f.replaces === 'SF-CORRIDOR-V4'));
const walk = new Map<string, Tri[]>([['SF-CORRIDOR-V4(v6 절단)', cut6], ...[...T].filter(([k]) => k !== 'SF-CORRIDOR' && !k.includes('CANOPY'))]);
const visibleZ = (x: number, y: number) => [...walk].map(([k, t]) => [k, zAt(t, x, y)] as const).filter(([, z]) => z != null) as [string, number][];
const steps = v6.features.filter((f: any) => ['stair_step', 'landing'].includes(f.properties.type));
const TOL = 0.15;
// 같은 면 S-MAP 내부 표본(사잇길 지형 셀 2 m, smap-mesh-reads-v3.json corridor_cells): 최근접 1개(1.5 m 안), 보간하지 않음
const CELLS: number[][] = JSON.parse(fs.readFileSync('C:/campus-tracker-backend/데이터/보완자료/3d-map-audit-20261009/claude-user-20261010/운동장구조/smap-mesh-reads-v3.json', 'utf8')).corridor_cells;
const cellZ = (x: number, y: number) => { let b: number[] | null = null, d = 1.5; for (const c of CELLS) { const e = Math.hypot(c[0] - x, c[1] - y); if (e <= d) { d = e; b = c; } } return b ? `S-MAP 사잇길 셀 (${b[0]},${b[1]}) ${b[2]} [${d.toFixed(1)} m]` : 'S-MAP 사잇길 셀 1.5 m 안 없음'; };
lines.push(`계단 접속(렌더 z, 허용 ${TOL} m, 넓히지 않음; 상태는 모두 미검증 유지)`);
for (const [sid, pre] of [['ST-DAEIL-EXIT-SIDE', 'V6-EXIT'], ['ST-A14', 'V6-A14']]) {
  const ss = steps.filter((f: any) => f.properties.id.startsWith(pre));
  const ep = JSON.parse(fs.readFileSync('C:/campus-tracker-backend/데이터/보완자료/3d-map-audit-20261009/claude-user-20261010/운동장구조/stair-endpoints-v6.json', 'utf8')).endpoints.filter((e: any) => e.stair === sid);
  const top = ep.find((e: any) => e.role.includes('상단')), bot = ep.find((e: any) => e.role.includes('하단'));
  const u = [bot.xy[0] - top.xy[0], bot.xy[1] - top.xy[1]]; const L = Math.hypot(u[0], u[1]); u[0] /= L; u[1] /= L;
  const RISER = 0.15; // 최저 단 상면에서 한 단 내려선 바닥이 하단 기대 z
  const zTop = Math.max(...ss.map((f: any) => f.properties.toM)), zBot = Math.round((Math.min(...ss.map((f: any) => f.properties.toM)) - RISER) * 1000) / 1000;
  for (const [name, p, dir, z] of [['상단(시작)', top.xy, -1, zTop], ['하단', bot.xy, 1, zBot]] as const) {
    const q = [p[0] + u[0] * 0.6 * dir, p[1] + u[1] * 0.6 * dir];
    const vs = visibleZ(q[0], q[1]);
    if (!vs.length) lines.push(`  ${sid} ${name}: 계단 z ${z} / 진행 방향 0.6 m 밖 보행 표면 없음 → 판정 불가` + (sid.startsWith('ST-DAEIL') && name.startsWith('상단') ? ' (출구 문턱 면 없음: 대일관 돌출 지붕 아래 출구 바닥 미모델)' : sid === 'ST-A14' && name === '하단' ? ' (141 m대 낮은 길 면 없음)' : ''));
    for (const [k, zv] of vs) lines.push(`  ${sid} ${name}: 계단 z ${z} / ${k} 렌더 ${zv.toFixed(2)} / 차 ${(z - zv).toFixed(2)} ${Math.abs(z - zv) <= TOL ? 'OK' : 'FAIL'} (보행 접속, 미검증) | 비교: ${cellZ(q[0], q[1])}`);
  }
  // 계단끼리: 같은 단 사슬 안 단 상면 차이(단높이 0.15 = 정상), 참 ↔ 앞뒤 단
  const land = ss.find((f: any) => f.properties.type === 'landing');
  if (land) {
    const zl = land.properties.toM;
    const f1 = ss.filter((f: any) => f.properties.id.startsWith(`${pre}-F1`)).map((f: any) => f.properties.toM);
    const f2 = ss.filter((f: any) => f.properties.id.startsWith(`${pre}-F2`)).map((f: any) => f.properties.toM);
    lines.push(`  ${sid} 계단참 ${zl}: 위 사슬 최저 단 상면 ${Math.min(...f1)}(차 ${(Math.min(...f1) - zl).toFixed(2)} = 한 단), 아래 사슬 최고 단 상면 ${Math.max(...f2)}(차 ${(zl - Math.max(...f2)).toFixed(2)}; 0이면 참과 같은 높이로 이어짐)`);
    // 참 옆(측면)의 사잇길 높이차 = 측벽(렌더 연결면) 문제, 보행 접속 실패가 아님
    const c = land.geometry.coordinates[0];
    const mx = (c[0][0] + c[2][0]) / 2, my = (c[0][1] + c[2][1]) / 2, n = [-u[1], u[0]];
    const side = visibleZ(mx + n[0] * 1.6, my + n[1] * 1.6);
    for (const [k, zv] of side) lines.push(`  ${sid} 계단참 측면 1.6 m: ${k} 렌더 ${zv.toFixed(2)} / 차 ${(zl - zv).toFixed(2)} → 측벽(렌더 연결면) 높이, 보행 접속 실패 아님`);
  }
}
fs.writeFileSync(new URL('docs/audit/field/render-z-checks.txt', ROOT), lines.join('\n') + '\n', 'utf8');
console.log(lines.join('\n'));
