import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Day, Lift, SetRow } from './api.ts';
import { buildItems, currentItem, entryFor, plannedWeight, rmOp, setOp, type Session } from './session.ts';

const row = (index: number, kind: SetRow['kind'], weight: number, reps: string, extra: Partial<SetRow> = {}): SetRow => ({
  index, kind, cell: '', pct: null, weight, sets: kind === 'supplemental' ? 5 : 1, reps, note: null, ...extra,
});

const lift = (key: 'squat' | 'bench', done = false): Lift => ({
  name: key, key,
  sets: [
    row(0, 'warmup', 20, '5', { done }), row(1, 'warmup', 40, '5', { done }), row(2, 'warmup', 60, '5', { done }),
    row(3, 'main', 75, '5', { pct: 0.75, done }), row(4, 'main', 85, '3', { pct: 0.85, done }),
    row(5, 'amrap', 95, '1+', { pct: 0.95, actual: done ? 8 : null }),
    row(6, 'supplemental', 75, '5', { pct: 0.75, done: [done, done, done, done, done] }),
  ],
});

const day = (firstDone = false): Day => ({
  day: 1, lifts: [lift('squat', firstDone), lift('bench')],
  assistance: [{ index: 0, name: 'dips', weight: null, sets: 5, reps: 8 }],
  rounds: [false, false, false, false, false], assistanceNote: null,
});

const session = (): Session => ({ cycle: 'cycle15', week: 3, day: 1, date: '2026-09-28', startedAt: '', entries: {} });

test('items: 11 per lift (5x5 split into sets) plus assistance rounds', () => {
  const items = buildItems(day());
  assert.equal(items.length, 11 + 11 + 5);
  assert.equal(items[6].id, 'L1:6.0');
  assert.equal(items[22].id, 'A:0');
});

test('current item skips what the sheet already has', () => {
  const d = day(true);
  assert.equal(currentItem(buildItems(d), session(), d)?.id, 'L2:0');
});

test('undo in the session overrides a stale done from the sheet', () => {
  const d = day(true);
  const s = session();
  s.entries['L1:3'] = { status: 'open', at: '' };
  const items = buildItems(d);
  assert.equal(entryFor(items[3], s, d), null);
  assert.equal(currentItem(items, s, d)?.id, 'L1:3');
});

test('5x5 weight follows the AMRAP entered today', () => {
  const d = day();
  const items = buildItems(d);
  const supp = items[6] as Extract<typeof items[number], { type: 'set' }>;
  const s = session();
  const tm = { squat: 100 };
  assert.equal(plannedWeight(supp, s, d, tm), 75); // no AMRAP yet: sheet value
  s.entries['L1:5'] = { status: 'done', reps: 12, at: '' };
  assert.equal(plannedWeight(supp, s, d, tm), 85);
  s.entries['L1:5'] = { status: 'done', reps: 16, at: '' };
  assert.equal(plannedWeight(supp, s, d, tm), 95);
});

test('ops carry actual values and the deviation status', () => {
  const d = day();
  const items = buildItems(d);
  const it = items[4] as Extract<typeof items[number], { type: 'set' }>;
  const op = setOp(it, session(), { status: 'changed', weight: 82.5, reps: 3, note: 'knee', at: '' }, { weight: 85, reps: '3' });
  assert.equal(op.status, 'changed');
  assert.equal(op.actualWeight, 82.5);
  assert.equal(op.lift, 1);
  assert.equal(op.set, 4);
  assert.equal(setOp(it, session(), null, { weight: 85, reps: '3' }).status, 'undo');
});

test('rm row uses the weight actually lifted and leaves out skipped AMRAPs', () => {
  const d = day();
  const items = buildItems(d);
  const s = session();
  s.entries['L1:5'] = { status: 'changed', weight: 92.5, reps: 9, at: '' };
  s.entries['L2:5'] = { status: 'skipped', at: '' };
  const op = rmOp(items, s, d)!;
  assert.deepEqual(op.lifts, { squat: { weight: 92.5, reps: 9 } });
  assert.equal(op.id, 'rm-cycle15-w3d1-2026-09-28');
});
