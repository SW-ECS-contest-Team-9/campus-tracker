import assert from 'node:assert/strict';
import test from 'node:test';
import * as C from 'cesium';
import { elevationRange, colorizeGeometry, elevationMaterial } from '../src/elevation-colors.ts';

test('one fixed range includes terrain, building bases and roofs, ignoring missing values', () => {
  assert.deepEqual(elevationRange(new Float32Array([NaN, 106.6, 149, 132]), [
    { baseM: 90, roofM: 221 }, { baseM: NaN, roofM: Infinity },
  ]), { min: 90, max: 230 });
  assert.deepEqual(elevationRange(new Float32Array([100, 100]), []), { min: 100, max: 110 });
});

test('building walls use surface altitude, with the same mapping as ground, without moving vertices', () => {
  const geometry = C.PolygonGeometry.createGeometry(new C.PolygonGeometry({
    polygonHierarchy: new C.PolygonHierarchy(C.Cartesian3.fromDegreesArray([
      127.01, 37.61, 127.011, 37.61, 127.011, 37.611, 127.01, 37.611,
    ])), height: 132, extrudedHeight: 160,
    vertexFormat: C.MaterialAppearance.MaterialSupport.TEXTURED.vertexFormat,
  }))!;
  const before = Array.from(geometry.attributes.position.values);
  const indices = Array.from(geometry.indices!);
  colorizeGeometry(C, geometry, { min: 100, max: 200 });
  assert.deepEqual(Array.from(geometry.attributes.position.values), before);
  assert.deepEqual(Array.from(geometry.indices!), indices);
  const coordinates = geometry.attributes.st!.values;
  const values = new Set<number>();
  for (let i = 0; i < before.length / 3; i++) {
    const h = C.Cartographic.fromCartesian(C.Cartesian3.fromArray(before, i * 3)).height;
    assert.ok(Math.abs(coordinates[i * 2] - (h - 100) / 100) < 1e-6);
    assert.equal(coordinates[i * 2 + 1], 0.5);
    values.add(Math.round(coordinates[i * 2] * 100));
  }
  assert.deepEqual([...values].sort(), [32, 60]);
});

test('cached elevation materials can be recreated for selection and opacity changes', () => {
  const image = 'data:image/png;base64,iVBORw0KGgo=';
  const range = { min: 50, max: 200 };
  const initial = elevationMaterial(C, image, range, false);
  const rebuilt = elevationMaterial(C, image, range, false, 0.5);
  assert.equal(initial.uniforms.image, rebuilt.uniforms.image);
  assert.equal(rebuilt.uniforms.opacity, 0.5);
  assert.equal(rebuilt.isTranslucent(), true);
  assert.equal(initial.uniforms.opacity, 1);
});
