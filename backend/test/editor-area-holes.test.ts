import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AreaSave, areaPolygon } from '../src/modules/editor/area.dto.js';

const outer: [number,number][] = [[201000,557000],[201020,557000],[201020,557020],[201000,557020]];
const hole: [number,number][] = [[201005,557005],[201005,557010],[201010,557010],[201010,557005]];

test('중정 구멍을 저장해도 링과 입력 좌표가 보존된다', () => {
  const input = {name:'중정 주변 로비',kind:'lobby',elevationM:142,coordinates:outer,holes:[hole]};
  const parsed = AreaSave.parse(input);
  assert.deepEqual(parsed.holes,[hole]);
  const polygon = areaPolygon(parsed.coordinates,parsed.holes);
  assert.equal(polygon.coordinates.length,2);
  assert.deepEqual(polygon.coordinates[1],[...hole,hole[0]]);
  assert.equal(hole.length,4);
});

test('구멍 링의 점 수와 좌표 범위를 검증한다', () => {
  const input = {name:'로비',kind:'lobby',elevationM:142,coordinates:outer};
  assert.equal(AreaSave.safeParse({...input,holes:[hole.slice(0,2)]}).success,false);
  assert.equal(AreaSave.safeParse({...input,holes:[[[0,0],[1,0],[1,1]]]}).success,false);
  assert.equal(AreaSave.safeParse(input).success,true);
});
