import assert from 'node:assert/strict';
import { register } from 'node:module';
import test from 'node:test';

// src 모듈의 확장자 없는 상대 import('./tm')를 node 테스트에서 .ts로 해석
register('data:text/javascript,export async function resolve(s,c,n){try{return await n(s,c)}catch(e){if(s.startsWith(".")&&!s.endsWith(".ts"))return n(s+".ts",c);throw e}}', import.meta.url);
const { editorLayerData, layerDataKey } = await import('../src/scene-layer-data.ts');
const { tmForward } = await import('../src/tm.ts');

const road = (id: string, more: object = {}) => ({
  id, name: null, roadClass: 'pedestrian', structure: 'ordinary', widthM: null, levelId: null, buildingId: null, fromNodeId: `${id}-a`, toNodeId: `${id}-b`,
  geometry: { coordinates: [[201100, 557250, 135], [201110, 557250, 135]] }, ...more,
});

test('편집기 자료 → 면 자료: 승강기는 빼고, 나머지 도로는 그대로', () => {
  const data = editorLayerData([road('a'), road('lift', { structure: 'elevator' }), road('car', { roadClass: 'vehicle', widthM: 7.2 })], null, []);
  assert.deepEqual(data.roads.map((r: { id: string }) => r.id), ['a', 'car']);
  assert.deepEqual(data.roads[1], { id: 'car', name: null, roadClass: 'vehicle', structure: 'ordinary', widthM: 7.2, levelId: null, buildingId: null,
    fromNodeId: 'car-a', toNodeId: 'car-b', geometry: { type: 'LineString', coordinates: [[201100, 557250, 135], [201110, 557250, 135]] } });
});

test('저장 전 편집: 고치는 도로는 초안의 꼭짓점·속성으로, 새 도로는 꼭짓점 둘부터 따로 들어간다', () => {
  const moved = [[201100, 557250, 135], [201110, 557260, 136], [201120, 557260, 136]];
  const edited = editorLayerData([road('a'), road('b')], { id: 'a', coordinates: moved, attrs: { structure: 'stairs', widthM: 3, pedestrianAccess: 'allowed' } }, []);
  assert.deepEqual(edited.roads[0].geometry.coordinates, moved);
  assert.equal(edited.roads[0].structure, 'stairs');
  assert.equal(edited.roads[0].widthM, 3);
  assert.equal(edited.roads[0].fromNodeId, 'a-a', '고치는 도로는 제 노드에 붙은 채');
  assert.equal('pedestrianAccess' in edited.roads[0], false);
  assert.deepEqual(edited.roads[1].geometry.coordinates, road('b').geometry.coordinates);
  // 새 도로: 점 하나일 때는 없다가 둘이 되면 생긴다. 끝은 아직 어느 노드에도 안 붙는다
  const draft = { id: 'new', coordinates: [[201100, 557270, 135]], attrs: { roadClass: 'vehicle', structure: 'ordinary', widthM: null, name: null, levelId: null, buildingId: null } };
  assert.equal(editorLayerData([road('a')], draft, []).roads.length, 1);
  const two = editorLayerData([road('a')], { ...draft, coordinates: [...draft.coordinates, [201120, 557270, 135]] }, []);
  assert.equal(two.roads.length, 2);
  assert.equal(two.roads[1].roadClass, 'vehicle');
  assert.notEqual(two.roads[1].fromNodeId, two.roads[1].toNodeId);
  // 초안을 승강기로 바꾸면 면에서 빠진다
  assert.equal(editorLayerData([road('a')], { id: 'a', coordinates: moved, attrs: { structure: 'elevator' } }, []).roads.length, 0);
});

test('영역: 미터 좌표 고리를 경위도로 (되돌리면 1 mm 안)', () => {
  const ring = [[201150, 557200], [201200, 557200], [201200, 557280], [201150, 557200]];
  const { areas } = editorLayerData([], null, [{ id: 1, name: '운동장', kind: 'other', elevationM: 148.9, buildingId: null, floor: null, geometry: { coordinates: [ring] } }]);
  assert.equal(areas[0].name, '운동장');
  assert.equal(areas[0].elevationM, 148.9);
  areas[0].geometry.coordinates[0].forEach(([lon, lat]: number[], i: number) => {
    const p = tmForward(lat, lon);
    assert.ok(Math.hypot(p.x - ring[i][0], p.y - ring[i][1]) < 0.001);
  });
});

test('자료가 같으면 열쇠도 같다: 표시와 무관한 값(개정 번호 등)이 바뀌어도 면을 다시 만들지 않는다', () => {
  const key = layerDataKey(editorLayerData([road('a', { revision: 1, status: 'DRAFT' })], null, []));
  assert.equal(layerDataKey(editorLayerData([road('a', { revision: 2, status: 'APPROVED', displayColor: '#ff0000' })], null, [])), key);
  assert.notEqual(layerDataKey(editorLayerData([road('a', { widthM: 4 })], null, [])), key);
});
