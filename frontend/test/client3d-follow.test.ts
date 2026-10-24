import assert from 'node:assert/strict';
import test from 'node:test';

const { BuildingFollow } = await import('../src/client3d-follow.ts');

const ok = (t: number, building: string | null) => ({ t, building, state: 'ok' as const });

test('처음 확실한 위치는 바로: 건물 안이면 그 건물, 바깥이면 null', () => {
  const f = new BuildingFollow();
  assert.deepEqual(f.update(ok(0, '북악관')), { from: null, to: '북악관' });
  const g = new BuildingFollow();
  assert.deepEqual(g.update(ok(0, null)), { from: null, to: null });
  assert.equal(g.current, null);
});

test('다른 건물로: 3번 이어져야 바뀜(앞 건물은 돌려놓을 차례)', () => {
  const f = new BuildingFollow();
  f.update(ok(0, '북악관'));
  assert.equal(f.update(ok(1000, '본관')), null);
  assert.equal(f.update(ok(1500, '본관')), null);
  assert.deepEqual(f.update(ok(2000, '본관')), { from: '북악관', to: '본관' });
  assert.equal(f.current, '본관');
});

test('벽 근처 잡음: 왔다 갔다 하면 바뀌지 않음', () => {
  const f = new BuildingFollow();
  f.update(ok(0, '북악관'));
  for (let i = 1; i < 20; i++) assert.equal(f.update(ok(i * 1000, i % 2 ? '본관' : '북악관')), null);
  assert.equal(f.current, '북악관');
});

test('드문 위치: 2번이라도 3초 넘게 이어지면 바뀜', () => {
  const f = new BuildingFollow();
  f.update(ok(0, '북악관'));
  assert.equal(f.update(ok(1000, null)), null);
  assert.deepEqual(f.update(ok(4500, null)), { from: '북악관', to: null }, '바깥으로 나감');
});

test("'uncertain' 은 건물을 바꾸지 않고 쌓던 후보도 버림", () => {
  const f = new BuildingFollow();
  f.update(ok(0, '북악관'));
  f.update(ok(1000, '본관'));
  f.update(ok(1500, '본관'));
  assert.equal(f.update({ t: 1800, building: '본관', state: 'uncertain' }), null);
  assert.equal(f.update(ok(2000, '본관')), null, '후보가 처음부터 다시');
  assert.equal(f.current, '북악관');
  const g = new BuildingFollow();
  assert.equal(g.update({ t: 0, building: '본관', state: 'uncertain' }), null, '처음이 불확실이면 정하지 않음');
  assert.equal(g.current, undefined);
});
