import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { buildTarget } from '../scripts/gen.mjs';
import { createBackend } from './gas.mjs';
import { cycleTab, fixture } from './fixture.mjs';

const T = 'dev';
const fresh = () => createBackend(fixture(new Date('2026-09-29T12:00:00Z')), { token: T });

test('apps-script/live.js is up to date with src/live.ts', async () => {
  const out = await buildTarget('apps-script', false);
  assert.equal(readFileSync(new URL('../apps-script/live.js', import.meta.url), 'utf8'), out.outputFiles[0].text,
    'run: node scripts/gen.mjs apps-script');
});

test('fixture reads as a writable cycle with history', () => {
  const r = fresh().doGet({ token: T, action: 'bootstrap' });
  assert.ok(r.ok, r.error);
  const { cycle, previous, history } = r.data;
  assert.equal(cycle.name, 'cycle9');
  assert.ok(cycle.writable, cycle.layoutProblems.join('; '));
  assert.equal(cycle.weeks[0].days[0].lifts[0].sets[5].actual, 10);
  assert.equal(cycle.weeks[1].days[0].lifts[0].sets[5].actual, null);
  assert.equal(previous.name, 'cycle8');
  assert.equal(history.sessions.length, 16);
});

test('bad token is refused', () => {
  assert.equal(fresh().doGet({ token: 'nope', action: 'ping' }).ok, false);
});

test('set ops tick the sheet, AMRAPs write reps, HR goes to the log, duplicates are ignored', () => {
  const b = fresh();
  const op = (id, set, extra = {}) => ({ id, type: 'set', cycle: 'cycle9', week: 2, day: 1, lift: 1, set, status: 'done', ...extra });
  const r = b.doPost({
    token: T,
    ops: [op('a', 0, { hr: { done: 120, peak: 131, low: 95 } }), op('b', 5, { actualReps: 7 }), op('a', 0)],
  });
  assert.deepEqual(r.data.results.map((x) => x.status), ['applied', 'applied', 'duplicate']);
  const sheet = b.ss.getSheetByName('cycle9');
  // Week 2 row 30; lift 1 sets start 3 rows below; "actual" is 5 columns right of day 1's block at B.
  assert.equal(sheet.getRange(33, 7).getValue(), true);
  assert.equal(sheet.getRange(38, 7).getValue(), 7);
  const log = b.ss.getSheetByName('session log').getRange(1, 1, 3, 23).getValues();
  const col = (h) => log[0].indexOf(h);
  assert.equal(log[1][col('hr done')], 120);
  assert.equal(log[1][col('hr peak')], 131);
  assert.equal(log[2][col('hr done')], '');
});

test('hr samples are appended to their own tab', () => {
  const b = fresh();
  const start = Date.parse('2026-09-29T16:00:00Z') / 1000;
  const r = b.doPost({
    token: T,
    ops: [{ id: 'hr-1', type: 'hr', sessionDate: '2026-09-29', startedAt: '2026-09-29T16:00:00.000Z', samples: [[start + 5, 90], [start + 10, 101]] }],
  });
  assert.equal(r.data.results[0].status, 'applied');
  const rows = b.ss.getSheetByName('hr').getRange(1, 1, 3, 5).getValues();
  assert.deepEqual(rows[0], ['session date', 'started at', 'time', 'secs since start', 'bpm']);
  assert.deepEqual([rows[1][3], rows[1][4], rows[2][3], rows[2][4]], [5, 90, 10, 101]);
});

test('live session: push, read back, merge from a second device, close', () => {
  const b = fresh();
  const s = { cycle: 'cycle9', week: 2, day: 1, date: '2026-09-29', startedAt: '2026-09-29T16:00:00.000Z', entries: {} };
  const watch = { ...s, entries: { 'L1:0': { status: 'done', at: '2026-09-29T16:01:00.000Z' } } };
  const phone = { ...s, entries: { 'L1:1': { status: 'done', at: '2026-09-29T16:03:00.000Z' } } };
  assert.equal(b.doPost({ token: T, live: { session: watch } }).data.live.v, 1);
  const merged = b.doPost({ token: T, live: { session: phone } }).data.live;
  assert.deepEqual(Object.keys(merged.session.entries).sort(), ['L1:0', 'L1:1']);
  assert.deepEqual(b.doGet({ token: T, action: 'live' }).data, merged);
  const closed = b.doPost({ token: T, live: { close: 'cycle9/w2d1/2026-09-29' } }).data.live;
  assert.equal(closed.session, null);
  assert.equal(closed.closed.key, 'cycle9/w2d1/2026-09-29');
});

test('live session larger than one script property is split and rejoined', () => {
  const b = fresh();
  const entries = {};
  for (let i = 0; i < 300; i++) entries[`L1:${i}`] = { status: 'changed', note: 'ťažké, bolí koleno '.repeat(3), at: `2026-09-29T16:${String(i % 60).padStart(2, '0')}:00.000Z` };
  const s = { cycle: 'cycle9', week: 2, day: 1, date: '2026-09-29', startedAt: '2026-09-29T16:00:00.000Z', entries };
  b.doPost({ token: T, live: { session: s } });
  assert.ok(Number(b.props['live:n']) > 1);
  assert.equal(Object.keys(b.doGet({ token: T, action: 'live' }).data.session.entries).length, 300);
});

test('a cycle tab made ahead of time waits until the current one is finished', () => {
  const data = fixture(new Date('2026-09-29T12:00:00Z'));
  data.sheets.unshift(cycleTab(10, { squat: 145, bench: 100, deadlift: 175, press: 62.5, wide_bench: 90 }, 0).toJSON());
  const b = createBackend(data, { token: T });
  const boot = (params = {}) => b.doGet({ token: T, action: 'bootstrap', ...params }).data;

  assert.equal(boot().cycle.name, 'cycle9');
  assert.equal(boot().previous.name, 'cycle8');
  assert.equal(boot({ name: 'cycle10' }).cycle.name, 'cycle10');
  assert.equal(boot({ name: 'cycle99' }).cycle.name, 'cycle9');

  // Log every remaining AMRAP of cycle9 but keep the last workout open: it stays on cycle9.
  const last = { cycle: 'cycle9', week: 3, day: 4, date: '2026-09-29', startedAt: '2026-09-29T16:00:00.000Z', entries: {} };
  b.doPost({ token: T, live: { session: last } });
  let n = 0;
  for (const week of [2, 3]) for (const day of [1, 2, 3, 4]) for (const lift of [1, 2]) {
    const r = b.doPost({ token: T, ops: [{ id: `x${n++}`, type: 'set', cycle: 'cycle9', week, day, lift, set: 5, status: 'done', actualReps: 5 }] });
    assert.equal(r.data.results[0].status, 'applied', r.data.results[0].error);
  }
  assert.equal(boot().cycle.name, 'cycle9');

  b.doPost({ token: T, live: { close: 'cycle9/w3d4/2026-09-29' } });
  assert.equal(boot().cycle.name, 'cycle10');
  assert.equal(boot().previous.name, 'cycle9');
});

test('archive: every writable cycle in full, standards, assistance plan, bodyweight per cycle', () => {
  const b = fresh();
  const r = b.doGet({ token: T, action: 'archive' });
  assert.ok(r.ok, r.error);
  assert.deepEqual(r.data.cycles.map((c) => c.name), ['cycle9', 'cycle8']);
  const std = r.data.cycles[0].standards;
  assert.deepEqual(std.levels.map((l) => `${l.name}/${l.horizon}`), ['intermediate/2y', 'advanced/5y', 'elite/10y']);
  assert.deepEqual(std.rows.find((x) => x.name === 'squat').targets, [1.6, 2, 2.4]);
  assert.deepEqual(r.data.assistancePlan[0], { name: 'Dips', range: '8-12' });
  const hist = b.doGet({ token: T, action: 'history' }).data;
  assert.equal(hist.trainingMaxes[0].bodyweight, 82);
});

test('assistance rows carry per-round reps and notes typed into the sheet', () => {
  const b = fresh();
  const sheet = b.ss.getSheetByName('cycle8');
  sheet.getRange(24, 10).setValue(4); // week 1 day 1, first exercise, round 4 cell (c + 5 + 3)
  sheet.getRange(24, 12).setValue('bad night');
  const a = b.doGet({ token: T, action: 'cycle', name: 'cycle8' }).data.weeks[0].days[0].assistance[0];
  assert.deepEqual(a.roundReps, [null, null, null, 4, null]);
  assert.equal(a.note, 'bad night');
  assert.equal(b.doGet({ token: T, action: 'cycle', name: 'cycle8' }).data.weeks[0].days[0].assistance[1].roundReps, null);
});

test('bodyweight op writes AX6 and is logged', () => {
  const b = fresh();
  const r = b.doPost({ token: T, ops: [{ id: 'bw1', type: 'bodyweight', cycle: 'cycle9', actualWeight: 74.5, sessionDate: '2026-09-29' }] });
  assert.equal(r.data.results[0].status, 'applied', r.data.results[0].error);
  assert.equal(b.ss.getSheetByName('cycle9').getRange('AX6').getValue(), 74.5);
  assert.equal(b.doPost({ token: T, ops: [{ id: 'bw2', type: 'bodyweight', cycle: 'cycle9', actualWeight: 7 }] }).data.results[0].status, 'error');
});

test('new_cycle copies the tab first, sets TMs, clears what was logged and becomes current', () => {
  const b = fresh();
  const src = b.ss.getSheetByName('cycle9');
  src.getRange(24, 7).setNote('app: skipped'); // a round checkbox note
  src.getRange(24, 10).setValue(4);
  const tm = { squat: 142.5, bench: 98.75, deadlift: 172.5, press: 61.25, wide_bench: 88.75 };
  const op = { id: 'nc1', type: 'new_cycle', name: 'cycle10', from: 'cycle9', tm, bodyweight: 80 };
  const r = b.doPost({ token: T, ops: [op] });
  assert.equal(r.data.results[0].status, 'applied', r.data.results[0].error);
  assert.equal(b.ss.getSheets()[0].getName(), 'cycle10');
  assert.equal(b.doPost({ token: T, ops: [{ ...op, id: 'nc2' }] }).data.results[0].status, 'error');

  const c = b.doGet({ token: T, action: 'cycle', name: 'cycle10' }).data;
  assert.ok(c.writable, c.layoutProblems.join('; '));
  assert.deepEqual(c.tm, tm);
  assert.equal(c.bodyweight, 80);
  const d = c.weeks[0].days[0];
  assert.equal(d.lifts[0].sets[5].actual, null);
  assert.equal(d.lifts[0].sets[0].done, false);
  assert.deepEqual(d.lifts[0].sets[6].done, [false, false, false, false, false]);
  assert.deepEqual(d.rounds, [false, false, false, false, false]);
  assert.deepEqual(d.assistance.map((a) => [a.name, a.weight, a.sets, a.reps, a.roundReps]), [
    ['Dips', null, 5, null, null], ['Chin-ups', null, 5, null, null], ['Ab wheel', null, 3, null, null],
  ]);
  const sheet = b.ss.getSheetByName('cycle10');
  assert.equal(sheet.getRange(24, 7).getNote(), '');
  // Formulas survive (the weight formula of the first main set) and the source tab is untouched.
  assert.match(sheet.formulas['10,3'], /MROUND/);
  assert.equal(src.getRange(24, 10).getValue(), 4);
  // Nothing logged in cycle10 yet and cycle9 unfinished, but it was made to be trained next.
  assert.equal(b.doGet({ token: T, action: 'bootstrap' }).data.cycle.name, 'cycle10');
});
