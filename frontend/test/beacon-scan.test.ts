import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { HeardBeacons, buildCreateRequest, emptyForm, normalizeUuid, parseIBeacon, scanSupport } from '../src/beacon-scan.ts';

const packets = JSON.parse(fs.readFileSync(new URL('../../fixtures/beacon/ibeacon-packets.json', import.meta.url), 'utf8')).cases as
  { name: string; manufacturerId: number; data: string; expected: { uuid: string; major: number; minor: number; measuredPower: number } | null }[];
const bytes = (hex: string) => new Uint8Array((hex.match(/../g) ?? []).map((h) => parseInt(h, 16)));

test('iBeacon parser: shared packet fixture (same as Android), DataView input too', () => {
  for (const c of packets) {
    const frame = parseIBeacon(c.manufacturerId, bytes(c.data));
    assert.deepEqual(frame, c.expected, c.name);
    if (c.expected) {
      const b = bytes(c.data);
      assert.deepEqual(parseIBeacon(c.manufacturerId, new DataView(b.buffer)), c.expected, `${c.name} (DataView)`);
    }
  }
  assert.equal(parseIBeacon(0x004c, null), null);
});

test('heard list: strongest unregistered first, unusable RSSI ignored, registered marked', () => {
  const list = new HeardBeacons((k) => k.endsWith(':1:1'));
  const uuid = 'E2C56DB5-DFFB-48D2-B060-D0F5A71096E0';
  list.add({ uuid, major: 1, minor: 1, measuredPower: -59 }, -50, 1);
  list.add({ uuid, major: 1, minor: 2, measuredPower: -59 }, -80, 2);
  list.add({ uuid, major: 1, minor: 3, measuredPower: -59 }, -70, 3);
  list.add({ uuid, major: 1, minor: 2, measuredPower: -59 }, 127, 4);
  const rows = list.list();
  assert.deepEqual(rows.map((r) => r.minor), [3, 2, 1]);
  assert.equal(rows[1].count, 2);
  assert.equal(rows[1].maxRssi, -80);
  assert.ok(rows[2].registered);
  assert.equal(rows[0].uuid, uuid.toLowerCase());
});

test('heard list: a beacon registered after it was heard is shown as registered', () => {
  const known = new Set<string>();
  const list = new HeardBeacons((k) => known.has(k));
  const row = list.add({ uuid: 'e2c56db5-dffb-48d2-b060-d0f5a71096e0', major: 1, minor: 9, measuredPower: -59 }, -60, 1);
  assert.equal(list.list()[0].registered, false);
  known.add(row.key);
  assert.equal(list.list()[0].registered, true);
});

test('scan support explains why the browser cannot scan', () => {
  assert.equal(scanSupport({ isSecureContext: false, bluetooth: { requestLEScan: () => 0 } }).ok, false);
  assert.deepEqual((scanSupport({ isSecureContext: true }) as { reason: string }).reason, 'NO_WEB_BLUETOOTH');
  assert.deepEqual((scanSupport({ isSecureContext: true, bluetooth: {} }) as { reason: string }).reason, 'NO_LE_SCAN');
  assert.equal(scanSupport({ isSecureContext: true, bluetooth: { requestLEScan: () => 0 } }).ok, true);
});

test('registration form: UUID normalization, ranges, both coordinate forms, beacon without anchor', () => {
  assert.equal(normalizeUuid('{E2C56DB5DFFB48D2B060D0F5A71096E0}'), 'e2c56db5-dffb-48d2-b060-d0f5a71096e0');
  assert.equal(normalizeUuid('xyz'), null);
  const base = { ...emptyForm(), uuid: 'E2C56DB5DFFB48D2B060D0F5A71096E0', major: '1', minor: '2' };
  assert.deepEqual(buildCreateRequest(base), { body: { uuid: 'e2c56db5-dffb-48d2-b060-d0f5a71096e0', major: 1, minor: 2 } });
  const geo = buildCreateRequest({ ...base, measuredPowerDbm: '-59', label: ' hall ', buildingId: 'B07', floor: '3f', floorHeightM: '148.2',
    latitude: '37.6105', longitude: '126.9971', z: '150.7', horizontalAccuracyM: '1.5' });
  assert.deepEqual(geo, { body: { uuid: 'e2c56db5-dffb-48d2-b060-d0f5a71096e0', major: 1, minor: 2, measuredPowerDbm: -59, label: 'hall',
    anchor: { buildingId: 'B07', floor: '3F', floorHeightM: 148.2, position: { latitude: 37.6105, longitude: 126.9971, z: 150.7 }, horizontalAccuracyM: 1.5 } } });
  const grid = buildCreateRequest({ ...base, buildingId: 'outdoor', positionMode: 'grid', x: '201100', y: '557250', z: '60' });
  assert.deepEqual((grid as { body: { anchor: { position: unknown } } }).body.anchor.position, { x: 201100, y: 557250, z: 60 });
  const bad = buildCreateRequest({ ...base, uuid: '12', major: '70000', minor: '-1', measuredPowerDbm: '5.5', latitude: '10', floor: '0F' });
  assert.deepEqual(Object.keys((bad as { errors: object }).errors).sort(), ['buildingId', 'floor', 'latitude', 'longitude', 'major', 'measuredPowerDbm', 'minor', 'uuid', 'z']);
});
