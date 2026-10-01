import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EMPTY_LIVE, applyPush, mergeSessions, reconcile, sessionKey, touch } from './live.ts';
import type { Session } from './session.ts';

const base = (over: Partial<Session> = {}): Session => ({
  cycle: 'cycle15', week: 2, day: 1, date: '2026-09-29', startedAt: '2026-09-29T16:00:00.000Z', entries: {}, ...over,
});
const at = (min: number) => `2026-09-29T16:${String(min).padStart(2, '0')}:00.000Z`;

test('merge keeps the newest entry per set from either device', () => {
  const phone = base({ entries: { 'L1:0': { status: 'done', at: at(5) }, 'L1:1': { status: 'done', at: at(7) } } });
  const watch = base({ entries: { 'L1:1': { status: 'open', at: at(8) }, 'L1:2': { status: 'done', at: at(9) } } });
  const m = mergeSessions(phone, watch);
  assert.deepEqual(Object.keys(m.entries).sort(), ['L1:0', 'L1:1', 'L1:2']);
  assert.equal(m.entries['L1:1'].status, 'open', 'the later undo wins');
  assert.deepEqual(mergeSessions(watch, phone).entries, m.entries, 'order does not matter');
});

test('merge unions extras and honours removals from either side', () => {
  const x1 = { id: 'X+1', group: 'L1', label: 'extra set', weight: 80, reps: 5, at: at(10) };
  const x2 = { id: 'X+2', group: 'L1', label: 'extra set', weight: 80, reps: 5, at: at(11) };
  const phone = base({ extras: [x1, x2] });
  const watch = base({ extras: [x1], removedExtras: ['X+1'] });
  const m = mergeSessions(phone, watch);
  assert.deepEqual(m.extras?.map((x) => x.id), ['X+2']);
  assert.deepEqual(m.removedExtras, ['X+1']);
});

test('touch stamps changed fields; merge takes the later stamp', () => {
  const s0 = base({ liftOrder: [1, 0] });
  const phone = touch(s0, { ...s0, paused: ['L1'] }, at(10));
  const watch = touch(s0, { ...s0, paused: [], liftOrder: [0, 1] }, at(12));
  assert.equal(phone.stamps?.paused, at(10));
  const m = mergeSessions(phone, watch);
  assert.deepEqual(m.paused, [], 'watch un-paused later');
  assert.deepEqual(m.liftOrder, [0, 1]);
  assert.deepEqual(mergeSessions(watch, phone).paused, []);
  assert.equal(touch(s0, { ...s0 }).stamps, undefined, 'nothing changed, nothing stamped');
});

test('a finished workout stays finished after merging with a stale copy', () => {
  const stale = base({ entries: { 'L1:0': { status: 'done', at: at(5) } } });
  const done = touch(stale, { ...stale, finishedAt: at(50), rpe: 8 }, at(50));
  const m = mergeSessions(stale, done);
  assert.equal(m.finishedAt, at(50));
  assert.equal(m.rpe, 8);
});

test('server: pushes merge, bump the version, and unchanged pushes do not', () => {
  const s = base({ entries: { 'L1:0': { status: 'done', at: at(5) } } });
  const d1 = applyPush(EMPTY_LIVE, { session: s }, at(5));
  assert.equal(d1.v, 1);
  const d2 = applyPush(d1, { session: s }, at(6));
  assert.equal(d2, d1, 'same data, same doc');
  const d3 = applyPush(d2, { session: base({ entries: { 'L1:1': { status: 'done', at: at(8) } } }) }, at(8));
  assert.equal(d3.v, 2);
  assert.equal(Object.keys(d3.session!.entries).length, 2);
});

test('server: closing drops the session and blocks stale copies from coming back', () => {
  const s = base();
  const d1 = applyPush(EMPTY_LIVE, { session: s }, at(1));
  const d2 = applyPush(d1, { close: sessionKey(s) }, at(60));
  assert.equal(d2.session, null);
  const d3 = applyPush(d2, { session: { ...s, entries: { 'L1:0': { status: 'done', at: at(59) } } } }, at(61));
  assert.equal(d3.session, null, 'a device that missed the close cannot resurrect it');
  const again = base({ startedAt: at(62) });
  assert.equal(applyPush(d3, { session: again }, at(62)).session?.startedAt, at(62), 'restarting the same day later is fine');
});

test('server: a different workout replaces the live one only if it started later', () => {
  const today = base({ startedAt: at(10) });
  const yesterday = base({ date: '2026-09-28', startedAt: '2026-09-28T16:00:00.000Z' });
  const d1 = applyPush(EMPTY_LIVE, { session: today }, at(10));
  assert.equal(applyPush(d1, { session: yesterday }, at(11)).session?.date, '2026-09-29');
});

test('device: picks up a workout started elsewhere, merges its own, drops closed ones', () => {
  const remote = base({ entries: { 'L1:0': { status: 'done', at: at(5) } } });
  const doc = applyPush(EMPTY_LIVE, { session: remote }, at(5));
  assert.deepEqual(reconcile(null, doc, '2026-09-29'), remote);
  assert.equal(reconcile(null, doc, '2026-09-30'), null, "yesterday's leftover is not picked up");

  const local = base({ entries: { 'L1:1': { status: 'done', at: at(6) } } });
  assert.equal(Object.keys(reconcile(local, doc, '2026-09-29')!.entries).length, 2);

  const closed = applyPush(doc, { close: sessionKey(remote) }, at(30));
  assert.equal(reconcile(local, closed, '2026-09-29'), null);
});
