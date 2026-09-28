import assert from 'node:assert/strict';
import { test } from 'node:test';
import { e1rm, repPrAt, repTable, repsToBeat, supplementalPct, trend, type Amrap } from './stats.ts';

const a = (date: string, weight: number, reps: number): Amrap => ({ date, weight, reps, e1rm: e1rm(weight, reps) });

test('e1rm matches the sheet formula', () => {
  assert.equal(e1rm(100, 1), 100);
  assert.equal(e1rm(80, 11), 100);
});

test('repsToBeat is the smallest rep count strictly above the target', () => {
  assert.equal(repsToBeat(100, 80), 12); // 11 reps ties 100 exactly
  assert.equal(repsToBeat(99, 80), 11);
  assert.equal(repsToBeat(50, 80), 1);
});

test('rep PR at exact weight', () => {
  const list = [a('2026-01-01', 80, 8), a('2026-02-01', 80, 10), a('2026-03-01', 82.5, 12)];
  assert.equal(repPrAt(list, 80)?.reps, 10);
  assert.equal(repPrAt(list, 90), null);
});

test('supplemental % follows the sheet rule', () => {
  assert.equal(supplementalPct(9, [0.75, 0.85, 0.95]), 0.75);
  assert.equal(supplementalPct(10, [0.75, 0.85, 0.95]), 0.85);
  assert.equal(supplementalPct(15, [0.75, 0.85, 0.95]), 0.95);
});

test('trend compares the last window to the window before it', () => {
  const list = [a('2025-01-01', 200, 1), a('2026-05-01', 80, 11), a('2026-09-01', 90, 11)];
  assert.equal(trend(list, 90, new Date('2026-09-28')), 12.5); // old all-time best ignored
});

test('rep table for a 1+ set starts near the interesting reps', () => {
  const list = [a('2026-01-01', 95, 8)];
  const rows = repTable({ weight: 95, minReps: 1, list, tm: 100, mainPcts: [0.75, 0.85, 0.95], key: 'squat', week: 3, lastReps: 7 });
  assert.equal(rows[0].reps, 3); // at least 9 rows, ending 2 past the PR mark
  assert.equal(rows.at(-1)?.reps, 11);
});

test('rep table marks where you beat the best e1RM', () => {
  const list = [a('2026-01-01', 80, 11)]; // best e1RM 100
  const rows = repTable({ weight: 80, minReps: 5, list, tm: 100, mainPcts: [0.75, 0.85, 0.95], key: 'squat', week: 3 });
  assert.equal(rows.find((r) => r.beatsBest)?.reps, 12);
  assert.equal(rows.find((r) => r.reps === 12)?.isRepPr, true);
  assert.equal(rows.find((r) => r.reps === 10)?.suppWeight, 85);
  assert.equal(rows.find((r) => r.reps === 14)?.tmBump, 5); // <15 reps: +2 x 2.5
});
