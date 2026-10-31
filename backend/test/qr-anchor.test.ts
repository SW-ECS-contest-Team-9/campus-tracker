import { test } from 'node:test';
import assert from 'node:assert/strict';
import { qrAnchorInput } from '../src/modules/editor/qr-anchor.routes.js';

test('QR anchor validation enforces floor, coordinate bounds, and normalized labels', () => {
  const input = { label: '  현관  ', buildingId: 'B01', floor: 'b1', coordinate: [200000, 550000, 140] };
  assert.deepEqual(qrAnchorInput.parse(input), { ...input, label: '현관', floor: 'B1' });
  assert.equal(qrAnchorInput.safeParse({ ...input, floor: null }).success, false);
  assert.equal(qrAnchorInput.safeParse({ ...input, buildingId: 'outdoor', floor: null }).success, true);
  assert.equal(qrAnchorInput.safeParse({ ...input, coordinate: [0, 550000, 140] }).success, false);
  assert.equal(qrAnchorInput.safeParse({ ...input, floor: '0F' }).success, false);
  assert.equal(qrAnchorInput.safeParse({ ...input, label: '  ' }).success, false);
});
