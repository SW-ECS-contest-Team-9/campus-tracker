// Collection anchors (backend markers/marker-anchor.ts): what a marker says about where the collector was.
import type { Marker } from './api';

const TYPE_LABEL: Record<string, string> = {
  sessionStart: '시작', sessionEnd: '끝', stairStart: '계단 시작', stairEnd: '계단 끝', elevatorBoard: '승강기 탑승',
  elevatorExit: '승강기 하차', entrance: '출입구', rampStart: '경사로 시작', rampEnd: '경사로 끝',
};

/** Short label: "시작 · 북악관 3F", "계단 시작 ↑ 1F→3F", or the raw type for markers without anchor fields. */
export function anchorLabel(m: Pick<Marker, 'type' | 'buildingId' | 'floor' | 'direction' | 'fromFloor' | 'toFloor' | 'nodeId'>): string {
  const place = m.buildingId === 'outdoor' ? '바깥' : [m.buildingId, m.floor].filter(Boolean).join(' ');
  const dir = m.direction === 'up' ? '↑' : m.direction === 'down' ? '↓' : '';
  const floors = m.fromFloor || m.toFloor ? `${m.fromFloor ?? '?'}→${m.toFloor ?? '?'}` : '';
  return [TYPE_LABEL[m.type] ?? m.type, place, [dir, floors].filter(Boolean).join(' '), m.nodeId ? '노드' : ''].filter(Boolean).join(' · ');
}

/** The marker names where the collector was (any anchor field), not only what happened there. */
export const isAnchor = (m: Pick<Marker, 'nodeId' | 'buildingId' | 'floor' | 'fromFloor'>) =>
  Boolean(m.nodeId || m.buildingId || m.floor || m.fromFloor);
