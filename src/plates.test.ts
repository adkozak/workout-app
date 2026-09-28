import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_INVENTORY, planLoadings, plateSteps, stacksFor, type Inventory } from './plates.ts';

const inv: Inventory = DEFAULT_INVENTORY;

const show = (targets: number[]) =>
  planLoadings(targets, inv).map((l) => `${l.total}:${l.perSide.join('+') || 'bar'}(${l.changes})`);

test('prefers two 5s over swapping a 5 for a 10', () => {
  const plan = planLoadings([60, 70, 80], inv);
  assert.deepEqual(plan.map((l) => l.perSide), [[20], [20, 5], [20, 5, 5]]);
  assert.deepEqual(plan.map((l) => l.changes), [1, 1, 1]);
});

test('respects inventory', () => {
  assert.deepEqual(stacksFor(10, { 5: 1, 10: 0 }), []);
  assert.ok(stacksFor(30, { 20: 1, 10: 1, 5: 2 }).every((s) => s.filter((p) => p === 20).length <= 1));
});

test('repeated supplemental sets cost nothing', () => {
  const plan = planLoadings([75, 75, 75, 75, 75], inv);
  assert.deepEqual(plan.slice(1).map((l) => l.changes), [0, 0, 0, 0]);
});

test('unloadable weight falls back to nearest and is flagged', () => {
  const plan = planLoadings([600], inv);
  assert.equal(plan[0].exact, false);
  assert.ok(plan[0].total < 600);
});

test('real sessions (cycle15 week 3 day 3)', () => {
  // wide bench: warm-ups, 75/85/95%, supplemental
  console.log('wide bench', show([20, 30, 40, 45, 50, 57.5, 45, 45, 45, 45, 45]).join('  '));
  console.log('squat     ', show([20, 40, 60, 75, 85, 95, 75, 75, 75, 75, 75]).join('  '));
  console.log('deadlift  ', show([60, 60, 60, 80, 92.5, 102.5, 80, 80, 80, 80, 80]).join('  '));
});

test('plate steps pull outer plates first, then add', () => {
  assert.deepEqual(plateSteps([20, 5, 2.5], [20, 10]), { remove: [2.5, 5], add: [10] });
  assert.deepEqual(plateSteps([20], [20, 5]), { remove: [], add: [5] });
  assert.deepEqual(plateSteps([20, 5], [20, 5]), { remove: [], add: [] });
});
