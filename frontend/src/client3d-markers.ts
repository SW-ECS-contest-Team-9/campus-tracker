// 경로 끝 표지(출발·도착·층 이동) 배치. 브라우저·Cesium 에 의존하지 않음(시험 가능).
// 같은 자리(평면 mergeM 안)의 표지는 한 이름표로 합치고("→ B1 · 도착"), 가까운(nearM 안) 표지는 위로 한 칸씩 쌓아 겹치지 않게 한다.
import type { Xyz } from './client3d-protocol';

export type MarkerKind = 'start' | 'end' | 'change';
export interface RouteMarker {
  at: Xyz;
  kind: MarkerKind;
  text: string;
  /** 0 = 기본 자리, 1.. = 가까운 앞 표지 위로 쌓을 칸 수 */
  stack: number;
}

const flat = (a: Xyz, b: Xyz) => Math.hypot(a[0] - b[0], a[1] - b[1]);

export function routeMarkers(
  points: Xyz[],
  floorChanges: { at: Xyz; label: string | null }[],
  opt: { mergeM?: number; nearM?: number } = {},
): RouteMarker[] {
  const mergeM = opt.mergeM ?? 6;
  const nearM = opt.nearM ?? 25;
  if (!points.length) return [];
  const start = { at: points[0], kind: 'start' as MarkerKind, parts: ['출발'] };
  const end = { at: points[points.length - 1], kind: 'end' as MarkerKind, parts: ['도착'] };
  const changes: { at: Xyz; kind: MarkerKind; parts: string[] }[] = [];
  for (const c of floorChanges) {
    const text = c.label ?? '층 이동';
    if (flat(c.at, end.at) < mergeM) end.parts.unshift(text);
    else if (flat(c.at, start.at) < mergeM) start.parts.push(text);
    else {
      const prev = changes[changes.length - 1];
      // 이어진 층 이동(승강기·계단으로 여러 층)은 마지막(도착 층)만
      if (prev && flat(prev.at, c.at) < mergeM) changes[changes.length - 1] = { at: c.at, kind: 'change', parts: [text] };
      else changes.push({ at: c.at, kind: 'change', parts: [text] });
    }
  }
  // 층 이동 이름표에 같은 내용이 겹치면 하나만(예: "→ B1 · → B1")
  const all = [start, ...changes, end].map((m) => ({ at: m.at, kind: m.kind, text: [...new Set(m.parts)].join(' · ') }));
  const out: RouteMarker[] = [];
  for (const m of all) {
    const taken = new Set(out.filter((o) => flat(o.at, m.at) < nearM).map((o) => o.stack));
    let stack = 0;
    while (taken.has(stack)) stack++;
    out.push({ ...m, stack });
  }
  return out;
}
