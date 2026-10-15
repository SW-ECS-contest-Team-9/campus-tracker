import assert from 'node:assert/strict';
import test from 'node:test';

const { parseCommand, imageUrl, originAllowed, floorNumber, matchFloor, throttle } = await import('../src/client3d-protocol.ts');

const PNG = 'data:image/png;base64,iVBORw0KGgo=';

test('v 가 없거나 다르면 거절', () => {
  assert.equal(parseCommand({ type: 'clearRoute' }).ok, false);
  assert.equal(parseCommand({ v: 2, type: 'clearRoute' }).ok, false);
  assert.deepEqual(parseCommand({ v: 1, type: 'clearRoute' }), { ok: true, command: { type: 'clearRoute' } });
});

test('JSON 문자열도 받음(React Native WebView), 깨진 JSON·배열·모르는 명령은 거절', () => {
  assert.equal(parseCommand(JSON.stringify({ v: 1, type: 'clearLocation' })).ok, true);
  assert.equal(parseCommand('{oops').ok, false);
  assert.equal(parseCommand([1, 2]).ok, false);
  const r = parseCommand({ v: 1, type: 'deleteEverything' });
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.command, 'deleteEverything');
});

test('setLocation: 기본값과 검사', () => {
  const r = parseCommand({ v: 1, type: 'setLocation', lon: 127.0135, lat: 37.6152, accuracyM: 8, state: 'ok' });
  assert.ok(r.ok);
  assert.deepEqual(r.ok && r.command, { type: 'setLocation', lon: 127.0135, lat: 37.6152, z: null, accuracyM: 8, floor: null, building: null, state: 'ok', markerUrl: null });
  const f = parseCommand({ v: 1, type: 'setLocation', lon: 127, lat: 37, accuracyM: 8, state: 'uncertain', floor: -1, z: 140.2, building: '북악관', markerUrl: PNG });
  assert.ok(f.ok && f.command.type === 'setLocation' && f.command.floor === 'B1' && f.command.z === 140.2);
  for (const bad of [
    { lon: 'x', lat: 37, accuracyM: 1, state: 'ok' },
    { lon: 127, lat: 95, accuracyM: 1, state: 'ok' },
    { lon: 127, lat: 37, accuracyM: -1, state: 'ok' },
    { lon: 127, lat: 37, accuracyM: 1, state: 'maybe' },
    { lon: 127, lat: 37, accuracyM: 1, state: 'ok', z: 'high' },
    { lon: 127, lat: 37, accuracyM: 1, state: 'ok', floor: 0 },
    { lon: 127, lat: 37, accuracyM: 1, state: 'ok', markerUrl: 'javascript:alert(1)' },
  ]) assert.equal(parseCommand({ v: 1, type: 'setLocation', ...bad }).ok, false, JSON.stringify(bad));
});

test('setRoute: EPSG:5186 점과 z, 층 바뀜 점', () => {
  const p = (dy: number, z = 140): number[] => [201050, 557200 + dy, z];
  const r = parseCommand({ v: 1, type: 'setRoute', points: [p(0), p(10), p(20, 143.6)], floorChanges: [{ at: p(10), label: '계단 5F' }] });
  assert.ok(r.ok && r.command.type === 'setRoute' && r.command.points.length === 3 && r.command.floorChanges[0].label === '계단 5F');
  assert.equal(parseCommand({ v: 1, type: 'setRoute', points: [p(0)] }).ok, false, '점 하나');
  assert.equal(parseCommand({ v: 1, type: 'setRoute', points: [[127.01, 37.6, 0], [127.02, 37.6, 0]] }).ok, false, 'WGS84 를 잘못 보냄');
  assert.equal(parseCommand({ v: 1, type: 'setRoute', points: [[201050, 557200], [201050, 557210]] }).ok, false, 'z 없음');
  assert.equal(parseCommand({ v: 1, type: 'setRoute', points: [p(0), p(1)], floorChanges: [{ at: [1, 2, 3] }] }).ok, false);
  assert.equal(parseCommand({ v: 1, type: 'setRoute', points: Array.from({ length: 5001 }, (_, i) => p(i % 50)) }).ok, false, '점이 너무 많음');
});

test('focus, setFloor, setMarkerImages, setMode', () => {
  assert.ok(parseCommand({ v: 1, type: 'focus', x: 201050, y: 557200 }).ok);
  assert.equal(parseCommand({ v: 1, type: 'focus', x: 1, y: 2 }).ok, false);
  const f = parseCommand({ v: 1, type: 'setFloor', building: '북악관', floor: '5F' });
  assert.ok(f.ok && f.command.type === 'setFloor' && f.command.explode === false);
  assert.ok(parseCommand({ v: 1, type: 'setFloor', building: '북악관', floor: null, explode: true }).ok);
  assert.equal(parseCommand({ v: 1, type: 'setFloor', floor: '5F' }).ok, false, '건물 없음');
  assert.equal(parseCommand({ v: 1, type: 'setFloor', building: '북악관', explode: 'yes' }).ok, false);
  assert.ok(parseCommand({ v: 1, type: 'setMarkerImages', ok: PNG, uncertain: 'https://example.org/a.png' }).ok);
  assert.equal(parseCommand({ v: 1, type: 'setMarkerImages', ok: PNG }).ok, false);
  assert.ok(parseCommand({ v: 1, type: 'setMode', light: true }).ok);
  assert.equal(parseCommand({ v: 1, type: 'setMode', light: 1 }).ok, false);
  assert.deepEqual(parseCommand({ v: 1, type: 'setMode', ui: 'min' }), { ok: true, command: { type: 'setMode', light: null, ui: 'min' } });
  assert.equal(parseCommand({ v: 1, type: 'setMode', ui: 'tiny' }).ok, false);
  assert.equal(parseCommand({ v: 1, type: 'setMode' }).ok, false);
});

test('그림 주소: data:image base64, http(s), 같은 출처 경로만', () => {
  assert.ok(imageUrl(PNG));
  assert.ok(imageUrl('data:image/gif;base64,R0lGOD=='));
  assert.ok(imageUrl('/characters/a.png'));
  assert.equal(imageUrl('data:text/html;base64,PHNjcmlwdD4='), false);
  assert.equal(imageUrl('data:image/svg+xml;base64,PHN2Zz4='), false);
  assert.equal(imageUrl('/../etc/passwd'), false);
  assert.equal(imageUrl('https://a.org/x.png" onerror="x'), false);
  assert.equal(imageUrl('data:image/png;base64,' + 'A'.repeat(2_000_001)), false);
});

test('출처 허용 목록', () => {
  assert.ok(originAllowed('https://evil.example', '', false), '목록이 비면 모두');
  assert.ok(originAllowed('http://localhost:8081', 'http://localhost:8081, https://app.skuniv.example', false));
  assert.equal(originAllowed('https://evil.example', 'http://localhost:8081', false), false);
  assert.ok(originAllowed('', 'http://localhost:8081', true), '네이티브 WebView 안의 출처 없는 메시지');
  assert.equal(originAllowed('', 'http://localhost:8081', false), false);
});

test('층 이름과 층 고르기', () => {
  assert.equal(floorNumber('5F'), 5);
  assert.equal(floorNumber('b2'), -2);
  assert.equal(floorNumber('지하 1층'), -1);
  assert.equal(floorNumber('3층'), 3);
  assert.equal(floorNumber('옥상'), null);
  const floors = [{ m: 137.8, name: '지하 1층' }, { m: 141.2, name: '1층' }, { m: 145, name: null }];
  assert.equal(matchFloor(floors, 'B1'), 0);
  assert.equal(matchFloor(floors, '1F'), 1);
  assert.equal(matchFloor(floors, '2F', 145.6), 2, '이름이 없으면 높이로');
  assert.equal(matchFloor(floors, '9F', 160), -1);
});

test('throttle: 첫 호출은 바로, 사이 호출은 마지막 것 하나만', async () => {
  const got: number[] = [];
  const f = throttle((n: number) => got.push(n), 30);
  f(1); f(2); f(3);
  assert.deepEqual(got, [1]);
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(got, [1, 3]);
});
