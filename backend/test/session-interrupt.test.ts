// Manual interrupt eligibility (pure): only a session the phone has visibly left behind.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { manualInterruptBlock } from '../src/modules/sessions/session.service.js';

test('manual interrupt: ACTIVE + socket gone + nothing received lately, and nothing else', () => {
  assert.equal(manualInterruptBlock('ACTIVE', false, 'OFFLINE'), null);
  assert.equal(manualInterruptBlock('ACTIVE', true, 'OFFLINE'), 'COLLECTOR_CONNECTED'); // connected but silent: stop it on the phone
  assert.equal(manualInterruptBlock('ACTIVE', true, 'LIVE'), 'COLLECTOR_CONNECTED');
  assert.equal(manualInterruptBlock('ACTIVE', false, 'DELAYED'), 'RECENTLY_RECEIVED'); // socket dropped a moment ago (tunnel, elevator)
  assert.equal(manualInterruptBlock('ACTIVE', false, 'LIVE'), 'RECENTLY_RECEIVED');
  for (const status of ['FINISHED', 'INTERRUPTED']) assert.equal(manualInterruptBlock(status, false, 'OFFLINE'), 'NOT_ACTIVE');
});
