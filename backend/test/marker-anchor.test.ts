// Collection anchors: floor names, the training label, the node picker and the marker DTO (no DB).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { floorFromLevelId, floorNumber, trainingLabel, type AnchorFields } from '../src/modules/markers/marker-anchor.js';
import { anchorBuildings, pickAnchorNodes, toAnchorNode, type AnchorNodeRow } from '../src/modules/mobility/anchor-nodes.js';
import { MarkerCreateRequest } from '../src/modules/markers/marker.dto.js';

const at = (s: number) => new Date(Date.UTC(2026, 9, 15, 1, 0, s)).toISOString();
const m = (type: string, s: number, f: Partial<AnchorFields> = {}): AnchorFields => ({ type, timestamp: at(s), nodeId: null, buildingId: null,
  floor: null, direction: null, fromFloor: null, toFloor: null, ...f });
const start = m('sessionStart', 0, { nodeId: 'n1', buildingId: '북악관', floor: '3F' });
const end = m('sessionEnd', 99, { buildingId: 'outdoor', nodeId: 'n9' });

test('floor names: 1F/B1, read from the editor levelIds', () => {
  assert.equal(floorNumber('B2'), -2);
  assert.equal(floorNumber('12F'), 12);
  assert.equal(floorNumber('0F'), null);
  assert.equal(floorNumber('G'), null);
  assert.deepEqual(['3F', '지하1층', 'B2', '2층', 'L3', '5', 'outdoor', '북악관_Z146.18_추정', null].map(floorFromLevelId),
    ['3F', 'B1', 'B2', '2F', '3F', '5F', null, null, null]);
});

test('training label: start and end anchors, paired stairs and elevators with floors', () => {
  assert.deepEqual(trainingLabel([start, end]), { valid: true, problems: [], anchors: 2, nodeAnchors: 2 });
  // older app: free-form markers only
  assert.deepEqual(trainingLabel([m('stairStart', 1), m('stairEnd', 2), m('entrance', 3)]).problems,
    ['START_MISSING', 'END_MISSING', 'STAIR_INCOMPLETE']);
  // a floor without indoor nodes: building + floor is enough; outdoors needs the node
  assert.ok(trainingLabel([m('sessionStart', 0, { buildingId: '한림관', floor: 'B1' }), end]).valid);
  assert.deepEqual(trainingLabel([m('sessionStart', 0, { buildingId: 'outdoor' }), end]).problems, ['START_INCOMPLETE']);
  const up = { direction: 'up', fromFloor: '1F', toFloor: '3F' };
  assert.ok(trainingLabel([start, m('stairStart', 10, up), m('stairEnd', 20, up), end]).valid);
  assert.deepEqual(trainingLabel([start, m('stairStart', 10, up), end]).problems, ['STAIR_UNPAIRED']);
  assert.deepEqual(trainingLabel([start, m('stairStart', 10, up), m('stairEnd', 20, { direction: 'up' }), end]).problems, ['STAIR_INCOMPLETE']);
  const lift = { fromFloor: 'B1', toFloor: '5F' };
  assert.ok(trainingLabel([end, m('elevatorExit', 30, lift), m('elevatorBoard', 20, lift), start]).valid, 'any order in, time order inside');
  assert.deepEqual(trainingLabel([start, m('elevatorExit', 30, lift), end]).problems, ['ELEVATOR_UNPAIRED']);
  assert.deepEqual(trainingLabel([start, m('entrance', 5, { nodeId: 'n2', buildingId: '북악관' }), end]).problems, ['ENTRANCE_INCOMPLETE']);
  assert.deepEqual(trainingLabel([start, m('rampStart', 5, { buildingId: 'outdoor' }), end]).problems, ['RAMP_INCOMPLETE']);
});

test('marker DTO: anchor fields are optional; floors are normalized, bad ones refused', () => {
  const base = { markerId: '7f6c4b4e-8a9e-4c55-9d4c-3f1f0a3b9e11', sessionId: '1b0e2a4c-3d5f-4a6b-8c7d-9e0f1a2b3c4d', timestamp: at(0),
    type: 'stairStart', latitude: 37.6, longitude: 127.0 };
  assert.equal(MarkerCreateRequest.parse(base).nodeId, undefined);
  const full = MarkerCreateRequest.parse({ ...base, nodeId: '2b0e2a4c-3d5f-4a6b-8c7d-9e0f1a2b3c4d', buildingId: '북악관', floor: 'b1', direction: 'down', fromFloor: '2f', toFloor: 'B1' });
  assert.deepEqual([full.floor, full.fromFloor, full.toFloor, full.direction], ['B1', '2F', 'B1', 'down']);
  assert.throws(() => MarkerCreateRequest.parse({ ...base, floor: '지하1층' }));
  assert.throws(() => MarkerCreateRequest.parse({ ...base, direction: 'sideways' }));
});

const row = (id: string, x: number, f: Partial<AnchorNodeRow> = {}): AnchorNodeRow => ({ id, kind: 'junction', level_id: null, x: 200000 + x, y: 600000,
  z: 140, road_buildings: null, road_levels: null, structures: ['indoor_corridor'], road_names: null, footprint_building: null, place_name: null, ...f });

test('node picker: building from roads then footprint, floor from levels, same floor first, nearest first', () => {
  const from = { x: 200000, y: 600000 };
  const nodes = [
    row('a', 30, { road_buildings: ['북악관'], road_levels: ['3층'] }),
    row('b', 5, { road_buildings: ['북악관'] }),
    row('c', 10, { footprint_building: '북악관', road_levels: ['3F'], place_name: '북악관 3층 입구' }),
    row('d', 1, { structures: ['ordinary'] }),
    row('e', 2, { road_buildings: ['북악관'], road_levels: ['2F', '3F'], structures: ['stairs'] }),
  ].map((r) => toAnchorNode(r, from));
  assert.deepEqual(nodes.map((n) => [n.buildingId, n.floor]), [['북악관', '3F'], ['북악관', null], ['북악관', '3F'], ['outdoor', null], ['북악관', null]]);
  assert.equal(nodes[2].label, '북악관 3층 입구 · 복도');
  assert.equal(nodes[3].distanceM, 1);
  assert.deepEqual(pickAnchorNodes(nodes, { buildingId: '북악관', floor: '3F', includeUnknownFloor: true, limit: 10 }).map((n) => n.nodeId), ['c', 'a', 'e', 'b']);
  assert.deepEqual(pickAnchorNodes(nodes, { buildingId: '북악관', floor: '3F', includeUnknownFloor: false, limit: 10 }).map((n) => n.nodeId), ['c', 'a']);
  assert.deepEqual(pickAnchorNodes(nodes, { buildingId: 'outdoor', includeUnknownFloor: true, limit: 10 }).map((n) => n.nodeId), ['d']);
  const buildings = anchorBuildings(nodes, [{ buildingId: '한림관', buildingName: '한림관' }, { buildingId: '북악관', buildingName: '북악관' }]);
  assert.deepEqual(buildings.map((b) => [b.buildingId, b.nodeCount, b.floorsWithNodes]),
    [['outdoor', 1, []], ['북악관', 4, ['3F']], ['한림관', 0, []]]);
});
