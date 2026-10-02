import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { applyPush, localDate, sessionKey } from '../lib/shared.js';
import { b64decode, callApi, handle, makePackage, parseSetup } from '../lib/side.js';
import { clock, newStore, startBackend, zeppFetch } from './helpers.mjs';

let be;
let pkg;
before(async () => {
  be = await startBackend();
  pkg = await handle('package', {}, { fetchFn: zeppFetch, cfg: be.cfg });
});
after(() => be.close());
// Each test starts with no live workout on the server.
beforeEach(() => { for (const k of Object.keys(be.backend.props)) if (k.startsWith('live')) delete be.backend.props[k]; });

/** One sync round trip, as the page does it: store -> side service -> backend -> store. */
async function sync(store) {
  const req = store.syncRequest();
  const res = await handle('sync', req, { fetchFn: zeppFetch, cfg: be.cfg });
  return store.applySync(req, res);
}

function startedStore() {
  const now = clock();
  const store = newStore(now);
  store.setPackage(pkg);
  const d = store.suggestedDay();
  store.start(d.week, d.day);
  return { store, now };
}

test('setup codes decode, including non-ASCII', () => {
  const code = Buffer.from(JSON.stringify({ url: 'https://x/exec', token: 't', name: 'Tréning' })).toString('base64url');
  assert.deepEqual(parseSetup(`https://me.github.io/app/#setup=${code}`), { url: 'https://x/exec', token: 't', name: 'Tréning' });
  assert.equal(b64decode(Buffer.from('žltý kôň 💪').toString('base64')), 'žltý kôň 💪');
  assert.equal(parseSetup('garbage'), null);
});

test('backend calls follow Apps Script redirects and surface errors', async () => {
  const live = await callApi(zeppFetch, { url: `${be.url}?action=live&token=dev` });
  assert.equal(typeof live.v, 'number');
  await assert.rejects(callApi(zeppFetch, { url: `${be.url}?action=live&token=wrong` }), /bad token/);
});

test('the package is small and has what the watch needs', () => {
  const size = JSON.stringify(pkg).length;
  assert.ok(size < 40000, `package is ${size} bytes`);
  assert.equal(pkg.cycle.name, 'cycle9');
  assert.equal(pkg.cycle.weeks[0].days[0].lifts[0].sets[0].cell, undefined);
  assert.ok(pkg.amraps.squat.length >= 4);
  assert.deepEqual(pkg.lastCycle.squat[2], { weight: 122.5, reps: 6 });
});

test('the watch picks the next day, squat first, and plans plates', () => {
  const { store } = startedStore();
  assert.deepEqual([store.session.week, store.session.day], [2, 1]);
  const cur = store.current();
  assert.equal(cur.id, 'L1:0');
  assert.equal(cur.liftRef.key, 'squat');
  const { loading } = store.loadingOf(cur);
  assert.equal(loading.total, store.planned(cur).weight);
});

test('done logs the set with heart rate, queues an op; undo reverts; no rest after warm-ups, 1:30 after the rest', () => {
  const { store, now } = startedStore();
  for (const bpm of [95, 110, 128, 131, 120]) { now.advance(5); store.addHr(bpm); }
  const cur = store.current();
  assert.equal(store.done(cur), null);
  const e = store.session.entries[cur.id];
  assert.equal(e.status, 'done');
  assert.deepEqual(e.hr, { done: 120, peak: 131, low: 95 });
  assert.equal(cur.row.kind, 'warmup');
  assert.equal(store.rest, null);
  assert.equal(store.ops.length, 1);
  assert.equal(store.ops[0].type, 'set');
  assert.deepEqual(store.ops[0].hr, e.hr);
  assert.notEqual(store.current().id, cur.id);

  store.undo();
  assert.equal(store.session.entries[cur.id].status, 'open');
  assert.equal(store.current().id, cur.id);
  assert.equal(store.rest, null);
  assert.equal(store.ops[1].status, 'undo');

  while (store.current().row.kind === 'warmup') { now.advance(60); store.done(store.current()); }
  now.advance(60);
  store.done(store.current()); // first main set
  assert.equal(store.restLeft(), 90);
});

test('each exercise opens with an overview until its first set is logged', () => {
  const { store, now } = startedStore();
  const first = store.current();
  const ov = store.overview(first);
  assert.equal(ov.kind, 'lift');
  assert.equal(ov.warmups.length, 3);
  assert.deepEqual(ov.main.map((m) => m.reps), ['3', '3', '3+']); // week 2
  assert.ok(ov.main.every((m) => m.perSide === (m.weight - 20) / 2));
  assert.equal(ov.supplemental.sets, 5);
  now.advance(30);
  store.done(first);
  assert.equal(store.overview(store.current()), null, 'not after the first set');

  // Jump to assistance: its first round gets the assistance overview.
  const round = store.items().find((it) => it.type === 'round');
  const a = store.overview(round);
  assert.equal(a.kind, 'assistance');
  assert.equal(a.rounds, 5);
  assert.deepEqual(a.rows[0], { name: 'Dips', weight: 10, reps: 8 });
  assert.equal(store.overview(store.items().find((it) => it.type === 'round' && it.round === 1)), null, 'only before the first round');
});

test('a quick second tap is flagged as a possible double tap', () => {
  const { store, now } = startedStore();
  const items = store.items();
  const main = items.find((it) => it.type === 'set' && it.row.kind === 'main');
  store.doNext(main);
  now.advance(120);
  store.done(store.current());
  now.advance(3);
  const fb = store.done(store.current());
  assert.equal(fb.kind, 'double');
  fb.action();
  assert.equal(store.lastAction, null);
});

test('an AMRAP beyond the best e1RM is a PR, and the 5x5 weight follows it', () => {
  const { store, now } = startedStore();
  const amrap = store.items().find((it) => it.type === 'set' && it.row.kind === 'amrap' && it.lift === 1);
  const supp = store.items().find((it) => it.type === 'set' && it.row.kind === 'supplemental' && it.lift === 1);
  const before = store.planned(supp).weight;
  const info = store.amrapInfo(amrap);
  assert.ok(info.targets.some((t) => t.gold));
  now.advance(60);
  const fb = store.logSet(amrap, info.weight, 15);
  assert.equal(fb.kind, 'pr');
  assert.match(fb.text, /e1RM PR/);
  assert.equal(store.session.entries[amrap.id].status, 'done');
  assert.ok(store.planned(supp).weight > before, '15 reps moves the 5x5 to the third %');
});

test('sync writes ops to the sheet and shares the session through the live doc', async () => {
  const { store, now } = startedStore();
  now.advance(30);
  store.done(store.current());
  const ev = await sync(store);
  assert.equal(ev, null);
  assert.equal(store.ops.length, 0);
  assert.equal(store.sync.ok, true);
  const sheet = be.backend.ss.getSheetByName('cycle9');
  assert.equal(sheet.getRange(33, 7).getValue(), true, 'week 2 day 1 squat warm-up 1 ticked');
  const live = be.backend.doGet({ token: 'dev', action: 'live' }).data;
  assert.equal(sessionKey(live.session), sessionKey(store.session));

  // Nothing changed: the next sync only reads.
  assert.deepEqual(store.syncRequest(), { ops: [], push: null });
});

test('a set logged on the phone shows up on the watch; closing on the phone ends it there', async () => {
  const { store, now } = startedStore();
  await sync(store);
  const phone = be.backend.doGet({ token: 'dev', action: 'live' }).data.session;
  const at = new Date(now() + 60e3).toISOString();
  be.backend.doPost({ token: 'dev', live: { session: { ...phone, entries: { ...phone.entries, 'L1:0': { status: 'done', at } } } } });
  now.advance(61);
  const ev = await sync(store);
  assert.equal(ev.type, 'merged');
  assert.equal(store.current().id, 'L1:1');

  be.backend.doPost({ token: 'dev', live: { close: sessionKey(phone) } });
  const ev2 = await sync(store);
  assert.equal(ev2.type, 'closed-elsewhere');
  assert.equal(store.session, null);
});

test('a workout started on the phone is picked up by an idle watch', async () => {
  const now = clock();
  const store = newStore(now);
  store.setPackage(pkg);
  const live = be.backend.doGet({ token: 'dev', action: 'live' }).data;
  const s = { cycle: 'cycle9', week: 2, day: 2, date: localDate(new Date(now())), startedAt: new Date(now() + 1000).toISOString(), entries: {} };
  be.backend.doPost({ token: 'dev', live: { session: s } });
  assert.ok(applyPush(live, { session: s }).session);
  const ev = await sync(store);
  assert.equal(ev.type, 'joined');
  assert.equal(store.session.day, 2);
  assert.equal(store.current().liftRef.key, 'deadlift');
});

test('finish and save: rm calc row, summary with heart rate, hr tab, live closed', async () => {
  const { store, now } = startedStore();
  const logBefore = be.backend.ss.getSheetByName('session log')?.getLastRow() ?? 0;
  const rmBefore = be.backend.ss.getSheetByName('rm calc').getLastRow();
  let bpm = 90;
  for (const it of store.items().filter((x) => x.lift === 1)) {
    for (let k = 0; k < 12; k++) { now.advance(10); store.addHr((bpm = bpm >= 150 ? 90 : bpm + 5)); }
    if (it.row.kind === 'amrap') store.logSet(it, store.planned(it).weight, 7);
    else store.done(it);
  }
  store.finish();
  assert.ok(store.session.finishedAt);
  const sum = store.summary();
  assert.equal(sum.done, 11);
  assert.ok(sum.hr.max >= 145 && sum.hr.avg > 90, JSON.stringify(sum.hr));
  store.close(8);
  assert.equal(store.session, null);
  assert.ok(store.pendingClose);
  while (store.ops.length) await sync(store);
  assert.equal(store.pendingClose, null);

  const live = be.backend.doGet({ token: 'dev', action: 'live' }).data;
  assert.equal(live.session, null);
  assert.equal(be.backend.ss.getSheetByName('rm calc').getLastRow(), rmBefore + 1);
  const log = be.backend.ss.getSheetByName('session log');
  const rows = log.getRange(logBefore + 1, 1, log.getLastRow() - logBefore, 23).getValues();
  const summary = rows.find((r) => r[8] === 'workout summary');
  assert.ok(summary, 'summary row');
  assert.equal(summary[13], 8, 'RPE in actual reps');
  assert.equal(summary[20], sum.hr.max, 'hr peak');
  const hr = be.backend.ss.getSheetByName('hr');
  assert.ok(hr.getLastRow() > 20, `hr rows: ${hr.getLastRow()}`);
});

test('ops the backend rejects move to the failed list instead of retrying forever', async () => {
  const { store } = startedStore();
  store.enqueue({ id: 'bad-1', type: 'set', cycle: 'cycle9', week: 9, day: 1, lift: 1, set: 0, status: 'done' });
  await sync(store);
  assert.equal(store.ops.length, 0);
  assert.equal(store.failed.at(-1).id, 'bad-1');
  assert.match(store.sync.error, /bad week/);
});

test('a practice workout queues nothing, is not shared, and ignores the shared workout', async () => {
  const now = clock();
  const store = newStore(now);
  store.setPackage(pkg);
  const d = store.suggestedDay();
  store.start(d.week, d.day, true);
  store.done(store.current());
  assert.equal(store.ops.length, 0);
  assert.equal(store.syncRequest().push, null);
  await sync(store);
  assert.equal(be.backend.doGet({ token: 'dev', action: 'live' }).data.session, null);
  // A real workout started elsewhere doesn't take over the practice one.
  const phone = { cycle: pkg.cycle.name, week: d.week, day: d.day, date: localDate(), startedAt: new Date().toISOString(), entries: {} };
  be.backend.doPost({ token: 'dev', live: { session: phone } });
  await sync(store);
  assert.equal(store.session.practice, true);
  store.leave();
  assert.equal(store.pendingClose, null);
  assert.equal(store.ops.length, 0);
});

/** Log everything up to (not including) the first item matching `stop`, AMRAPs at 8 reps. */
function playUntil(store, now, stop) {
  for (let cur = store.current(); cur && !stop(cur); cur = store.current()) {
    now.advance(90);
    if (cur.type === 'set' && cur.row.kind === 'amrap') store.logSet(cur, store.planned(cur).weight, 8);
    else store.done(cur);
  }
}

test('leaving after the AMRAPs still adds the rm calc row', async () => {
  // Own backend: earlier tests already wrote today's rm row for this workout, and op ids dedupe.
  const own = await startBackend();
  const { store, now } = startedStore();
  const before = own.backend.doGet({ token: 'dev', action: 'history' }).data.sessions.length;
  playUntil(store, now, (it) => it.type === 'set' && it.row.kind === 'supplemental');
  store.leave();
  while (store.ops.length) {
    const req = store.syncRequest();
    store.applySync(req, await handle('sync', req, { fetchFn: zeppFetch, cfg: own.cfg }));
  }
  const rows = own.backend.doGet({ token: 'dev', action: 'history' }).data.sessions;
  await own.close();
  assert.equal(rows.length, before + 1);
  assert.equal(rows[rows.length - 1].lifts.squat.reps, 8);
});

test('a workout left open overnight is stale and finishes at its last logged set', () => {
  const { store, now } = startedStore();
  now.advance(60);
  store.done(store.current());
  const lastAt = store.session.entries[Object.keys(store.session.entries)[0]].at;
  assert.equal(store.stale(), false);
  now.advance(20 * 3600);
  assert.equal(store.stale(), true);
  store.finish();
  assert.equal(store.session.finishedAt, lastAt);
});

test('no rest after the last thing of the workout', () => {
  const { store, now } = startedStore();
  playUntil(store, now, () => false);
  assert.equal(store.current(), null);
  assert.equal(store.rest, null);
});

test('skipping a 5x5 set offers to skip the rest of the 5x5', () => {
  const { store, now } = startedStore();
  playUntil(store, now, (it) => it.type === 'set' && it.row.kind === 'supplemental');
  now.advance(90); store.done(store.current());
  const fb = store.skip(store.current());
  assert.equal(fb.kind, 'info');
  assert.match(fb.sub, /other 3/);
  fb.action();
  const supp = store.items().filter((it) => it.type === 'set' && it.row.kind === 'supplemental' && it.lift === 1);
  assert.deepEqual(supp.map((it) => store.entry(it).status), ['done', 'skipped', 'skipped', 'skipped', 'skipped']);
});

test('a round with fewer reps on one exercise logs them per exercise', () => {
  const { store, now } = startedStore();
  playUntil(store, now, (it) => it.type === 'round');
  now.advance(90);
  store.done(store.current(), [{ index: 1, reps: 4 }]);
  const op = store.ops[store.ops.length - 1];
  assert.equal(op.type, 'assist_round');
  assert.equal(op.note, '#2: 4');
});
