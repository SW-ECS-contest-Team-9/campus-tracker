import assert from 'node:assert/strict';
import test from 'node:test';

const { routeMarkers } = await import('../src/client3d-markers.ts');

const P = (x: number, y: number, z = 100): [number, number, number] => [x, y, z];

test('도착 자리의 층 이동은 도착 이름표에 합침', () => {
  const m = routeMarkers([P(0, 0), P(50, 0)], [{ at: P(49, 1, 90), label: '→ B1' }]);
  assert.deepEqual(m.map((x) => x.text), ['출발', '→ B1 · 도착']);
});

test('이어진 층 이동은 마지막만, 다른 자리는 따로', () => {
  const m = routeMarkers([P(0, 0), P(200, 0)], [
    { at: P(100, 0), label: '→ 2F' },
    { at: P(101, 0), label: '→ 1F' },
    { at: P(150, 0), label: null },
  ]);
  assert.deepEqual(m.map((x) => x.text), ['출발', '→ 1F', '층 이동', '도착']);
});

test('가까운 표지는 위로 쌓음(겹치지 않게)', () => {
  const m = routeMarkers([P(0, 0), P(20, 0)], [{ at: P(10, 0), label: '→ 1F' }]);
  assert.deepEqual(m.map((x) => x.stack), [0, 1, 2]);
  const far = routeMarkers([P(0, 0), P(300, 0)], [{ at: P(150, 0), label: '→ 1F' }]);
  assert.deepEqual(far.map((x) => x.stack), [0, 0, 0]);
});

test('빈 경로', () => {
  assert.deepEqual(routeMarkers([], []), []);
});
