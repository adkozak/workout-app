// Everything the watch knows and does, without any UI: today's plan (the
// "package" the phone sends), the workout in progress, the queue of sheet ops,
// heart rate, the rest timer, and syncing with the phone. The page renders
// from this and calls its actions; tests drive it directly.
//
// Session logic is the phone app's own (src/session.ts etc., bundled into
// shared.js), so both produce identical sheet ops.

import {
  DEFAULT_INVENTORY, bestE1rm, buildItems, currentItem, defaultLiftOrder, e1rm, effectiveStart, entryFor,
  extraOp, findDay, groupOf, localDate, newSession, nextDay, planLoadings, plannedReps, plannedWeight,
  finishTime, isStale, previousCompletion, reconcile, repPrAt, repsToBeat, REST_SECS, restFor, rmOp, roundOp, sessionKey, setOp, summaryOp,
  timing, timingWarning, tonnage, touch, uuid, canon,
} from './shared.js';
import { clock, kg, kg1, liftName } from './format.js';

export const BAR = 20;
const HR_KEEP_MS = 5000; // one stored sample per 5 s
const HR_OP_SAMPLES = 60; // send samples in 5-minute batches
const HR_RECENT_MS = 30 * 60e3;
const HR_PUSH_MS = 15000; // share the current bpm with the phone this often
const MAX_OPS_PER_SYNC = 40;

const iso = (ms) => new Date(ms).toISOString();

export class Store {
  /**
   * @param {{ get(key: string): any, set(key: string, value: any): void }} storage
   * @param {() => number} now
   */
  constructor(storage, now = () => Date.now()) {
    this.storage = storage;
    this.now = now;
    const get = (k, d) => { const v = storage.get(k); return v === undefined || v === null ? d : v; };
    this.pkg = get('pkg', null);
    this.session = get('session', null);
    this.ops = get('ops', []);
    this.failed = get('failed', []);
    this.inventory = get('inventory', { value: DEFAULT_INVENTORY, at: '' });
    this.inventoryDirty = get('inventoryDirty', false);
    this.serverJson = get('serverJson', null);
    this.pendingClose = get('pendingClose', null);
    this.rest = get('rest', null);
    this.hrStats = get('hrStats', null);
    this.hrBuffer = get('hrBuffer', []);
    this.recentHr = [];
    this.lastHr = null;
    this.lastHrPushed = 0;
    this.lastHrSessionUpdate = 0;
    this.lastAction = null;
    this.sync = { ok: null, at: null, error: null };
    this.listeners = new Set();
    this.memo = {};
  }

  // ---------- plumbing ----------

  onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit(event) { this.listeners.forEach((fn) => fn(event)); }

  save(...keys) {
    for (const k of keys) this.storage.set(k, this[k]);
  }

  setSession(next, { stamp = true } = {}) {
    this.session = next && stamp ? touch(this.session, next, iso(this.now())) : next;
    this.save('session');
    this.emit({ type: 'session' });
  }

  enqueue(...ops) {
    if (this.session && this.session.practice) return; // practice: nothing goes to the sheet
    this.ops = [...this.ops, ...ops.filter(Boolean)];
    this.save('ops');
  }

  // ---------- plan ----------

  setPackage(pkg) {
    this.pkg = pkg;
    this.memo = {};
    this.save('pkg');
    this.emit({ type: 'package' });
  }

  get cycle() { return this.pkg ? this.pkg.cycle : null; }

  /** The day to offer on the home screen: the first one with an AMRAP not logged. */
  suggestedDay() {
    const c = this.cycle;
    if (!c) return null;
    const n = nextDay(c);
    return n ? { week: n.week, day: n.day.day, lifts: this.dayLifts(n.day) } : null;
  }

  dayLifts(day) { return defaultLiftOrder(day).map((i) => liftName(day.lifts[i])).join(' + '); }

  allDays() {
    const c = this.cycle;
    if (!c) return [];
    return c.weeks.flatMap((w) => w.days.map((d) => ({
      week: w.week, day: d.day, lifts: this.dayLifts(d),
      logged: d.lifts.every((l) => l.sets.filter((s) => s.kind === 'amrap').every((s) => s.actual != null)),
    })));
  }

  day() {
    const s = this.session, c = this.cycle;
    if (!s || !c || s.cycle !== c.name) return null;
    return findDay(c, s.week, s.day);
  }

  order() {
    const d = this.day();
    return this.session.liftOrder || (d ? defaultLiftOrder(d) : []);
  }

  items() {
    const d = this.day();
    if (!d) return [];
    const order = this.order();
    const rounds = this.session.roundCount != null ? this.session.roundCount : d.rounds.length;
    const key = `${this.session.cycle}|${this.session.week}|${this.session.day}|${order.join()}|${rounds}`;
    if (this.memo.itemsKey !== key || this.memo.itemsDay !== d) {
      this.memo.items = buildItems(d, order, rounds);
      this.memo.itemsKey = key;
      this.memo.itemsDay = d;
    }
    return this.memo.items;
  }

  current() {
    const d = this.day();
    return d ? currentItem(this.items(), this.session, d) : null;
  }

  entry(item) { return entryFor(item, this.session, this.day()); }

  planned(item) {
    return { weight: plannedWeight(item, this.session, this.day(), this.cycle.tm), reps: item.row.reps };
  }

  /** Plate plan for the item's lift over the weights used so far and planned for the rest. */
  loadingOf(item) {
    const its = this.items().filter((it) => it.type === 'set' && it.lift === item.lift);
    const weights = its.map((it) => {
      const e = this.session.entries[it.id];
      return e && e.weight != null ? e.weight : this.planned(it).weight;
    });
    const key = `${weights.join()}|${JSON.stringify(this.inventory.value)}`;
    this.memo.loadings = this.memo.loadings || {};
    let plan = this.memo.loadings[key];
    if (!plan) {
      try { plan = planLoadings(weights, this.inventory.value, BAR); } catch (e) { plan = null; }
      this.memo.loadings = { [key]: plan }; // one lift at a time is plenty
    }
    const i = its.indexOf(item);
    if (!plan || i < 0) return null;
    return { loading: plan[i], prev: i > 0 ? plan[i - 1].perSide : [] };
  }

  progress() {
    const items = this.items();
    return { done: items.filter((it) => this.entry(it)).length, total: items.length };
  }

  elapsedSecs() {
    return this.session ? (this.now() - Date.parse(effectiveStart(this.session))) / 1000 : 0;
  }

  // ---------- AMRAP helper ----------

  amrapList(key) {
    const raw = (this.pkg && this.pkg.amraps && this.pkg.amraps[key]) || [];
    return raw.map(([date, weight, reps]) => ({ date, weight, reps, e1rm: e1rm(weight, reps) }));
  }

  /** Where to start the rep counter and which rep counts mean something today. */
  amrapInfo(item) {
    const key = item.liftRef.key;
    const weight = this.planned(item).weight;
    const target = plannedReps(item.row);
    const list = key ? this.amrapList(key) : [];
    const last = list[list.length - 1];
    const lc = key && this.pkg.lastCycle && this.pkg.lastCycle[key] ? this.pkg.lastCycle[key][this.session.week] : null;
    const best = bestE1rm(list);
    const pr = repPrAt(list, weight);
    const match = (t) => repsToBeat(t - 1e-6, weight);
    const targets = [
      last && { label: 'last time', reps: match(last.e1rm) },
      lc && { label: `last cycle wk${this.session.week}`, reps: match(e1rm(lc.weight, lc.reps)) },
      pr && { label: `rep PR @${kg(weight)}`, reps: pr.reps + 1 },
      best && { label: 'e1RM PR', reps: repsToBeat(best.e1rm, weight), gold: true },
    ].filter(Boolean).sort((a, b) => a.reps - b.reps);
    const e = this.session.entries[item.id];
    return {
      weight, target, targets, best, pr,
      start: e && e.reps != null ? e.reps : Math.max(target, lc ? lc.reps : target),
    };
  }

  // ---------- actions ----------

  start(week, dayNo, practice = false) {
    const s = newSession(this.cycle, week, dayNo, practice);
    s.startedAt = iso(this.now());
    s.date = localDate(new Date(this.now()));
    this.hrStats = null;
    this.hrBuffer = [];
    this.lastAction = null;
    this.save('hrStats', 'hrBuffer');
    this.setSession(s, { stamp: false });
  }

  opFor(item, s, entry) {
    return item.type === 'set'
      ? setOp(item, s, entry, { weight: this.planned(item).weight, reps: item.row.reps })
      : roundOp(item.round, s, entry, this.day().rounds.length);
  }

  /**
   * Log an item (entry null = undo). Returns feedback for the UI:
   * { kind: 'pr' | 'info' | 'double' | 'missed', text, sub?, action? }.
   */
  record(item, entry, { rest = true } = {}) {
    const s = this.session;
    const day = this.day();
    const at = iso(this.now());
    if (entry && entry.status !== 'skipped') {
      const hr = this.hrMarks(s, entry.at);
      if (hr) entry = { ...entry, hr };
    }
    const entries = { ...s.entries, [item.id]: entry || { status: 'open', at } };
    const next = { ...s, entries, cursor: item.id };
    this.setSession(next);
    this.enqueue(this.opFor(item, this.session, entry));
    this.lastAction = entry ? { item } : null;
    if (!entry) { this.endRest(); return null; }
    if (entry.status === 'skipped') return null;
    if (rest) {
      const secs = restFor(item);
      // No rest between warm-up sets, or after the last thing of the workout.
      if (secs > 0 && this.current()) this.startRest(secs);
      else this.endRest();
    }
    if (item.type === 'set' && item.row.kind === 'amrap' && entry.reps != null && item.liftRef.key) return this.celebrate(item, entry);
    const w = timingWarning(item, timing(this.session, entry.at, item.id).secsSincePrevious, this.items(), this.session, day);
    if (w && w.kind === 'double') {
      return { kind: 'double', text: `Two sets ${w.secs}s apart`, sub: 'Double tap? Tap to undo', action: () => this.undo() };
    }
    if (w && w.kind === 'missed') {
      const mid = iso((Date.parse(previousCompletion(this.session, entry.at, item.id)) + Date.parse(entry.at)) / 2);
      const n = w.next;
      return {
        kind: 'missed', text: `${clock(w.secs)} since the last one`, sub: 'Did two? Tap to log one more',
        action: () => this.record(n, {
          status: 'done', at: mid,
          weight: n.type === 'set' ? this.planned(n).weight : undefined,
          reps: n.type === 'set' ? plannedReps(n.row) : undefined,
        }, { rest: false }),
      };
    }
    return null;
  }

  /** `detail`: for a round, reps per exercise where they differ from the plan ([{index, reps}]). */
  done(item, detail) {
    const at = iso(this.now());
    if (item.type === 'round') return this.record(item, { status: 'done', at, ...(detail && detail.length ? { detail } : {}) });
    return this.record(item, { status: 'done', weight: this.planned(item).weight, reps: plannedReps(item.row), at });
  }

  /** A set with its actual weight/reps; 'done' if that's the plan. AMRAP reps never count as a change. */
  logSet(item, weight, reps) {
    if (item.type === 'set' && item.row.kind === 'amrap' && !reps) return this.skip(item); // 0 reps: failed, not an AMRAP
    const p = this.planned(item);
    const changed = Math.abs(weight - p.weight) > 1e-9 || (item.row.kind !== 'amrap' && reps !== plannedReps(item.row));
    return this.record(item, { status: changed ? 'changed' : 'done', weight, reps, at: iso(this.now()) });
  }

  /** Skip a set. For a 5x5 set, offers to skip the ones left too (stopping the 5x5 early). */
  skip(item) {
    const fb = this.record(item, { status: 'skipped', at: iso(this.now()) });
    if (item.type !== 'set' || item.row.kind !== 'supplemental') return fb;
    const left = this.items().filter((it) => it.type === 'set' && it.lift === item.lift && it.set === item.set && !this.entry(it));
    if (!left.length) return fb;
    return {
      kind: 'info', text: '5x5 set skipped', sub: `Tap to skip the other ${left.length} too`,
      action: () => { for (const it of left) if (!this.entry(it)) this.record(it, { status: 'skipped', at: iso(this.now()) }); return null; },
    };
  }

  /** A workout still open from an earlier day. */
  stale() { return isStale(this.session, new Date(this.now())); }

  undo() {
    const a = this.lastAction;
    if (!a) return null;
    this.lastAction = null;
    return this.record(a.item, null);
  }

  doNext(item) {
    const s = this.session;
    this.setSession({ ...s, cursor: item.id, paused: (s.paused || []).filter((g) => g !== groupOf(item)) });
  }

  togglePause(group) {
    const paused = this.session.paused || [];
    this.setSession({ ...this.session, paused: paused.includes(group) ? paused.filter((g) => g !== group) : [...paused, group] });
  }

  swapOrder() {
    this.setSession({ ...this.session, liftOrder: [...this.order()].reverse() });
  }

  setRounds(n) {
    const d = this.day();
    const done = this.items().filter((it) => it.type === 'round' && this.entry(it)).length;
    if (!d || n < Math.max(1, done) || n > 10) return;
    this.setSession({ ...this.session, roundCount: n });
  }

  addExtra(group, weight, reps) {
    const day = this.day();
    const at = iso(this.now());
    const extra = { id: `X+${uuid().slice(0, 8)}`, group, label: 'extra set', weight, reps, at };
    const next = { ...this.session, extras: [...(this.session.extras || []), extra] };
    this.setSession(next);
    const lift = group === 'A' ? null : day.lifts[Number(group.slice(1)) - 1];
    this.enqueue(extraOp(extra, this.session, lift ? lift.key || lift.name : 'assistance'));
    this.startRest(REST_SECS);
  }

  /**
   * What an exercise holds, offered before its first set: for a lift the warm-ups,
   * the three main sets and the 5x5; for assistance each exercise with weight x reps.
   * Null once anything in the group is logged, or if `item` isn't its first item.
   */
  overview(item) {
    const day = this.day();
    if (!item || !day) return null;
    const group = groupOf(item);
    const its = this.items().filter((it) => groupOf(it) === group);
    if (its[0].id !== item.id || its.some((it) => this.entry(it))) return null;
    if (item.type === 'round') {
      return {
        group, kind: 'assistance', rounds: its.length,
        rows: day.assistance.map((a) => {
          const x = this.session.entries[`X:${a.index}`];
          const weight = x && x.weight != null ? x.weight : typeof a.weight === 'number' ? a.weight : null;
          return { name: x && x.name ? x.name : a.name, weight, reps: x && x.reps != null ? x.reps : a.reps };
        }),
      };
    }
    const perSide = (it) => {
      const l = this.loadingOf(it);
      return l ? (l.loading.total - BAR) / 2 : null;
    };
    const firstOf = (kind) => its.filter((it) => it.row.kind === kind && it.sub === 0);
    const supp = firstOf('supplemental')[0];
    return {
      group, kind: 'lift', name: liftName(item.liftRef), tm: item.liftRef.key ? this.cycle.tm[item.liftRef.key] : null,
      warmups: firstOf('warmup').map((it) => this.planned(it).weight),
      main: its.filter((it) => it.row.kind === 'main' || it.row.kind === 'amrap')
        .map((it) => ({ weight: this.planned(it).weight, reps: it.row.reps, perSide: perSide(it) })),
      supplemental: supp ? { weight: this.planned(supp).weight, sets: supp.row.sets, reps: supp.row.reps, perSide: perSide(supp) } : null,
    };
  }

  /** Lift groups and assistance with progress, for the "go to" list. */
  groups() {
    const items = this.items();
    const paused = this.session.paused || [];
    const out = [];
    for (const li of this.order()) {
      const lift = this.day().lifts[li];
      out.push({ group: `L${li + 1}`, name: liftName(lift) });
    }
    if (items.some((it) => it.type === 'round')) out.push({ group: 'A', name: 'Assistance' });
    return out.map((g) => {
      const its = items.filter((it) => groupOf(it) === g.group);
      const open = its.filter((it) => !this.entry(it));
      return { ...g, done: its.length - open.length, total: its.length, next: open[0] || null, paused: paused.includes(g.group) };
    });
  }

  finish() {
    const op = rmOp(this.items(), this.session, this.day());
    if (op) this.enqueue(op);
    this.flushHr(true);
    this.endRest();
    this.setSession({ ...this.session, finishedAt: finishTime(this.session, new Date(this.now())), hr: this.hrSummary() || this.session.hr });
  }

  /** Save the finished workout (with RPE) and put the watch back on the home screen. */
  close(rpe) {
    const s = this.session;
    const secs = (Date.parse(s.finishedAt) - Date.parse(effectiveStart(s))) / 1000;
    this.enqueue(summaryOp({ ...s, rpe: rpe == null ? undefined : rpe }, { secs, tonnage: tonnage(this.items(), s) }, rpe == null ? null : rpe, ''));
    this.drop(s);
  }

  /** Stop without finishing; what was logged stays in the sheet, AMRAPs included in rm calc. */
  leave() {
    const op = this.day() ? rmOp(this.items(), this.session, this.day()) : null;
    if (op) this.enqueue(op);
    this.flushHr(true);
    this.drop(this.session);
  }

  drop(s) {
    if (!s.practice) this.pendingClose = sessionKey(s);
    this.hrStats = null;
    this.lastAction = null;
    this.save('pendingClose', 'hrStats');
    this.endRest();
    this.setSession(null);
  }

  setInventory(value) {
    this.inventory = { value, at: iso(this.now()) };
    this.inventoryDirty = true;
    this.memo.loadings = null;
    this.save('inventory', 'inventoryDirty');
    this.emit({ type: 'inventory' });
  }

  // ---------- rest ----------

  startRest(secs) {
    this.rest = { endsAt: this.now() + secs * 1000, total: secs };
    this.save('rest');
  }

  addRest(secs) {
    if (!this.rest) return;
    this.rest = { ...this.rest, endsAt: this.rest.endsAt + secs * 1000, total: this.rest.total + secs };
    this.save('rest');
  }

  endRest() {
    if (!this.rest) return;
    this.rest = null;
    this.save('rest');
  }

  restLeft() { return this.rest ? Math.ceil((this.rest.endsAt - this.now()) / 1000) : null; }

  // ---------- heart rate ----------

  addHr(bpm, t = this.now()) {
    if (!(bpm > 20 && bpm < 250)) return;
    this.lastHr = { bpm, t };
    this.recentHr.push([t, bpm]);
    while (this.recentHr.length && this.recentHr[0][0] < t - HR_RECENT_MS) this.recentHr.shift();
    const s = this.session;
    if (!s || s.finishedAt) return;
    const st = this.hrStats || { sum: 0, count: 0, max: 0, min: 999 };
    this.hrStats = { sum: st.sum + bpm, count: st.count + 1, max: Math.max(st.max, bpm), min: Math.min(st.min, bpm) };
    const last = this.hrBuffer[this.hrBuffer.length - 1];
    if (!last || t - last[0] * 1000 >= HR_KEEP_MS) {
      this.hrBuffer.push([Math.round(t / 1000), bpm]);
      if (this.hrBuffer.length % 12 === 0) this.save('hrBuffer', 'hrStats');
    }
    if (t - this.lastHrSessionUpdate >= 60e3) {
      this.lastHrSessionUpdate = t;
      this.setSession({ ...s, hr: this.hrSummary() });
    }
  }

  hrSummary() {
    const st = this.hrStats;
    return st && st.count ? { avg: Math.round(st.sum / st.count), max: st.max, min: st.min, samples: st.count } : null;
  }

  /** Heart rate around a completion: now, and the highest/lowest since the previous one. */
  hrMarks(s, at) {
    const to = Date.parse(at);
    const from = Date.parse(previousCompletion(s, at));
    const win = this.recentHr.filter(([t]) => t >= from && t <= to);
    if (!win.length) return undefined;
    const lastT = win[win.length - 1][0];
    const bpms = win.map((x) => x[1]);
    return { done: to - lastT < 15000 ? win[win.length - 1][1] : undefined, peak: Math.max(...bpms), low: Math.min(...bpms) };
  }

  /** Turn buffered samples into an op; `all` also sends a partial batch. */
  flushHr(all = false) {
    const s = this.session;
    if (!s || !this.hrBuffer.length || (!all && this.hrBuffer.length < HR_OP_SAMPLES)) return;
    this.enqueue({ id: uuid(), type: 'hr', sessionDate: s.date, startedAt: s.startedAt, samples: this.hrBuffer });
    this.hrBuffer = [];
    this.save('hrBuffer', 'hrStats');
  }

  // ---------- AMRAP feedback ----------

  celebrate(item, entry) {
    const list = this.amrapList(item.liftRef.key);
    const w = entry.weight != null ? entry.weight : this.planned(item).weight;
    const est = e1rm(w, entry.reps);
    const best = bestE1rm(list);
    const pr = repPrAt(list, w);
    if (best && est > best.e1rm) return { kind: 'pr', text: `e1RM PR ${kg1(est)}`, sub: `+${kg1(est - best.e1rm)} kg over ${kg1(best.e1rm)}` };
    if (pr && entry.reps > pr.reps) return { kind: 'pr', text: `Rep PR ${kg(w)}×${entry.reps}`, sub: `was ${pr.reps}` };
    if (best) return { kind: 'info', text: `e1RM ${kg1(est)}`, sub: `${kg1(best.e1rm - est)} below best` };
    return null;
  }

  summary() {
    const s = this.session, items = this.items();
    const sets = items.filter((it) => it.type === 'set');
    const count = (st) => sets.filter((it) => (this.entry(it) || {}).status === st).length;
    const amraps = sets.filter((it) => it.row.kind === 'amrap' && it.liftRef.key).map((it) => {
      const e = this.entry(it);
      if (!e || e.status === 'skipped' || e.reps == null) return { name: liftName(it.liftRef), skipped: true };
      const w = e.weight != null ? e.weight : it.row.weight;
      const est = e1rm(w, e.reps);
      const list = this.amrapList(it.liftRef.key);
      const best = bestE1rm(list), pr = repPrAt(list, w);
      return { name: liftName(it.liftRef), weight: w, reps: e.reps, e1rm: est, pr: !!best && est > best.e1rm, repPr: !!pr && e.reps > pr.reps };
    });
    const end = s.finishedAt ? Date.parse(s.finishedAt) : this.now();
    return {
      secs: (end - Date.parse(effectiveStart(s))) / 1000,
      tonnage: tonnage(items, s),
      done: count('done'), changed: count('changed'), skipped: count('skipped'),
      amraps, hr: s.hr || this.hrSummary(),
    };
  }

  // ---------- sync ----------

  /** What to send on the next sync: queued ops and, if anything changed, the live push. */
  syncRequest() {
    const now = this.now();
    this.flushHr();
    const push = {};
    const practice = !!(this.session && this.session.practice);
    if (this.session && !practice && canon(this.session) !== this.serverJson) push.session = this.session;
    if (this.pendingClose) push.close = this.pendingClose;
    if (this.inventoryDirty) push.inventory = this.inventory;
    const s = this.session;
    if (s && !practice && !s.finishedAt && this.lastHr && now - this.lastHr.t < 30000 && now - this.lastHrPushed >= HR_PUSH_MS) {
      push.hr = { bpm: this.lastHr.bpm, at: iso(this.lastHr.t) };
    }
    return { ops: this.ops.slice(0, MAX_OPS_PER_SYNC), push: Object.keys(push).length ? push : null };
  }

  /** Apply the phone's answer to a syncRequest(). Throwing callers should use syncFailed(). */
  applySync(sent, { results = [], live = null }) {
    const byId = {};
    for (const op of sent.ops) byId[op.id] = op;
    const answered = new Set();
    const failed = [];
    for (const r of results) {
      answered.add(r.id);
      if (r.status === 'error' && byId[r.id]) failed.push({ ...byId[r.id], error: r.error });
    }
    if (answered.size) {
      this.ops = this.ops.filter((o) => !answered.has(o.id));
      this.save('ops');
    }
    if (failed.length) {
      this.failed = [...this.failed, ...failed].slice(-50);
      this.save('failed');
    }
    const now = this.now();
    if (sent.push && sent.push.hr) this.lastHrPushed = now;
    let event = null;
    if (live) {
      if (sent.push && sent.push.close && live.closed && live.closed.key === sent.push.close) {
        this.pendingClose = null;
        this.save('pendingClose');
      }
      if (sent.push && sent.push.inventory) { this.inventoryDirty = false; this.save('inventoryDirty'); }
      if (live.inventory && live.inventory.at > this.inventory.at) {
        this.inventory = live.inventory;
        this.memo.loadings = null;
        this.save('inventory');
      }
      this.serverJson = live.session ? canon(live.session) : null;
      this.save('serverJson');
      const before = this.session;
      // A practice workout stays local: the shared workout neither replaces nor closes it.
      const next = before && before.practice ? before : this.pendingClose ? null : reconcile(before, live, localDate(new Date(now)));
      if (canon(next) !== canon(before)) {
        if (before && !next) event = { type: 'closed-elsewhere' };
        else if (!before && next) event = { type: 'joined' };
        else event = { type: 'merged' };
        if (next && (!before || sessionKey(before) !== sessionKey(next))) { this.hrStats = null; this.hrBuffer = []; }
        if (!next) this.endRest();
        this.setSession(next, { stamp: false });
      }
    }
    this.sync = { ok: true, at: now, error: failed.length ? failed[0].error : null };
    this.emit({ type: 'sync', event });
    return event;
  }

  syncFailed(error) {
    this.sync = { ok: false, at: this.sync.at, error: String(error && error.message ? error.message : error) };
    this.emit({ type: 'sync' });
  }
}
