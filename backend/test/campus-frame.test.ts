// Campus frame (EPSG:5186 minus origin) and the TM inverse.  npm test -w backend
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmForward, tmInverse } from '../src/geo/tm.js';
import { CAMPUS_FRAME, fromCampus, toCampus } from '../src/geo/campus-frame.js';

test('TM inverse matches PostGIS EPSG:5186 references and round-trips within 1 mm', () => {
  const ref: [number, number, number, number][] = [
    [37.61500445350227, 127.01264376659661, 201116.3137220434, 557268.3267747858],
    [37.62, 127.0, 200000, 557822.7035618249],
    [37.61, 127.03, 202648.86701014065, 556713.2347360994],
    [37.5665, 126.978, 198056.36673702704, 551885.0305887164],
  ];
  for (const [lat, lon, x, y] of ref) {
    const g = tmInverse(x, y);
    const back = tmForward(g.latitude, g.longitude);
    assert.ok(Math.hypot(back.x - x, back.y - y) < 0.001, `round trip ${Math.hypot(back.x - x, back.y - y)} m`);
    // degrees -> meters (1e-7° ≈ 1 cm)
    const err = Math.hypot((g.latitude - lat) * 111_000, (g.longitude - lon) * 88_000);
    assert.ok(err < 0.01, `${lat},${lon}: ${err} m`);
  }
});

test('campus frame: origin offset, metric distances, inverse', () => {
  const c = toCampus(37.61500445350227, 127.01264376659661);
  assert.ok(Math.abs(c.x - (201116.3137 - CAMPUS_FRAME.originE)) < 0.01);
  assert.ok(Math.abs(c.y - (557268.3268 - CAMPUS_FRAME.originN)) < 0.01);
  const g = fromCampus(c.x + 100, c.y);
  const d = toCampus(g.latitude, g.longitude);
  assert.ok(Math.abs(d.x - c.x - 100) < 0.001 && Math.abs(d.y - c.y) < 0.001);
});
