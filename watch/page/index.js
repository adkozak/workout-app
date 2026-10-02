// The whole watch app is this one page. It shows whatever matters right now
// (today's workout, the current set, the rest countdown, the summary) with
// big tap targets, plus a few sub-screens (menu, change set, AMRAP reps,
// plates, day list). State and logic live in lib/store.js; this file draws
// it and wires up buttons, keys, heart rate, vibration, alarms and syncing.

import { align, createWidget, deleteWidget, event, prop, text_style, widget } from '@zos/ui';
import { getDeviceInfo } from '@zos/device';
import {
  GESTURE_RIGHT, KEY_BACK, KEY_DOWN, KEY_EVENT_CLICK, KEY_SELECT, KEY_SHORTCUT, KEY_UP,
  offGesture, offKey, onGesture, onKey,
} from '@zos/interaction';
import {
  pauseDropWristScreenOff, resetDropWristScreenOff, resetPageBrightTime, setPageBrightTime, setWakeUpRelaunch,
} from '@zos/display';
import {
  HeartRate, Vibrator, VIBRATOR_SCENE_DURATION_LONG, VIBRATOR_SCENE_SHORT_LIGHT, VIBRATOR_SCENE_SHORT_MIDDLE,
  VIBRATOR_SCENE_STRONG_REMINDER,
} from '@zos/sensor';
import { localStorage } from '@zos/storage';
import { cancel as cancelAlarm, set as setAlarm } from '@zos/alarm';
import { SCROLL_MODE_FREE, scrollTo, setScrollMode } from '@zos/page';
import { log } from '@zos/utils';
import { BasePage } from '@zeppos/zml/base-page';
import { BAR, Store } from '../lib/store.js';
import { clock, hhmm, kg, kg1, liftName } from '../lib/format.js';
import { e1rm, groupOf, plannedReps, plateSteps } from '../lib/shared.js';

const logger = log.getLogger('workout');

// ---------- layout: a 480x480 design scaled to the screen ----------

const { width: W, height: H } = getDeviceInfo();
const S = W / 480;
const px = (v) => Math.round(v * S);
const TOP = Math.max(0, Math.round((H - W) / 2)); // square screens: centre the design
const py = (v) => TOP + px(v);

const WHITE = 0xffffff, MUTED = 0x9a9a9a, ACCENT = 0x6f8cff, GOLD = 0xf5a524, RED_T = 0xff6b6b;
const GREEN = 0x1f8f3a, GREEN_P = 0x14602a, GRAY = 0x303030, GRAY_P = 0x505050, RED = 0x8a2525, RED_P = 0x5e1818;
const GOLD_BG = 0x5a4300, TOAST_BG = 0x1e1e1e;
const REST_BUZZ_EVERY_MS = 6000;
const REST_BUZZ_MAX_MS = 120000;
// Rest countdown ring around the screen edge, starting at 12 o'clock.
const RING = { x: px(10), y: py(10), w: px(460), h: px(460), start_angle: -90, line_width: px(14) };

// ---------- storage, sensors ----------

const storage = {
  get(k) {
    const raw = localStorage.getItem(k);
    if (raw === undefined || raw === null || raw === '') return undefined;
    try { return JSON.parse(raw); } catch (e) { return undefined; }
  },
  set(k, v) {
    if (v === undefined || v === null) localStorage.removeItem(k);
    else localStorage.setItem(k, JSON.stringify(v));
  },
};

const store = new Store(storage);
let vibrator = null;
let heart = null;

function stopBuzz() {
  try { if (vibrator) vibrator.stop(); } catch (e) { /* nothing running */ }
}

function buzz(mode) {
  try {
    if (!vibrator) vibrator = new Vibrator();
    vibrator.stop();
    vibrator.start({ mode });
  } catch (e) {
    logger.log(`vibrate failed ${e}`);
  }
}

// ---------- page state ----------

let page = null; // the BasePage instance, for this.request()
let widgets = [];
let ticking = {}; // widgets the 1 s tick updates in place
let view = null; // null: automatic (home / set / rest / summary); else a sub-screen
let toast = null; // { text, sub, action, until, gold }
let picked = null; // day chosen on the home screen, if not the suggested one
let envName = null; // "TEST" when paired with the test backend
let pkgLoading = false, pkgError = null;
let syncing = false, lastSyncAt = 0;
let restAlarm = { id: 0, endsAt: 0 };
let restOverAt = 0; // when the current rest ran out (0: still counting down, or no rest)
let restBuzzAt = 0;
let warnedFor = 0;
let seenOverview = {}; // exercises whose overview was dismissed, by workout + group
let awake = null;
let timer = null;
let renderQueued = false;

// ---------- widget helpers ----------

function add(type, opts) {
  const w = createWidget(type, opts);
  widgets.push(w);
  return w;
}

function clearAll() {
  for (const w of widgets) deleteWidget(w);
  widgets = [];
  ticking = {};
}

function text(x, y, w, h, str, size = 28, color = WHITE, extra = {}) {
  return add(widget.TEXT, {
    x: px(x), y: py(y), w: px(w), h: px(h), text: str, text_size: px(size), color,
    align_h: align.CENTER_H, align_v: align.CENTER_V, text_style: text_style.ELLIPSIS, ...extra,
  });
}

function wrapText(x, y, w, h, str, size = 28, color = WHITE) {
  return text(x, y, w, h, str, size, color, { text_style: text_style.WRAP });
}

function button(x, y, w, h, label, onClick, { color = GRAY, press = GRAY_P, size = 32, textColor = WHITE } = {}) {
  return add(widget.BUTTON, {
    x: px(x), y: py(y), w: px(w), h: px(h), text: label, text_size: px(size), color: textColor,
    radius: px(Math.min(h, w) / 2), normal_color: color, press_color: press,
    click_func: () => onClick(),
  });
}

const greenButton = (x, y, w, h, label, onClick, size = 44) => button(x, y, w, h, label, onClick, { color: GREEN, press: GREEN_P, size });
const redButton = (x, y, w, h, label, onClick, size = 26) => button(x, y, w, h, label, onClick, { color: RED, press: RED_P, size });

/** Re-render after the current click handler returns (never delete a widget inside its own callback). */
function rerender() {
  if (renderQueued) return;
  renderQueued = true;
  setTimeout(() => { renderQueued = false; render(); }, 1);
}

function setView(v) {
  view = v;
  rerender();
}

function back() {
  setView(view && view.parent ? view.parent : null);
}

function showToast(t, ms = 4000) {
  toast = { ...t, until: Date.now() + ms };
  rerender();
}

// ---------- rendering ----------

function autoView() {
  const s = store.session;
  if (!s) return { name: 'home' };
  if (!store.day()) return { name: 'missing' };
  if (s.finishedAt) return { name: 'summary' };
  // The rest screen stays after time is up (buzzing) until X is tapped.
  if (store.rest) return { name: 'rest' };
  const cur = store.current();
  if (!cur) return { name: 'alldone' };
  const ov = store.overview(cur);
  if (ov && !seenOverview[overviewKey(ov)]) return { name: 'overview', ov };
  return cur.type === 'round' ? { name: 'round', item: cur } : { name: 'set', item: cur };
}

const overviewKey = (ov) => `${store.session.cycle}/${store.session.week}/${store.session.day}/${store.session.startedAt}|${ov.group}`;

function dismissOverview(ov) {
  seenOverview[overviewKey(ov)] = true;
  view = null;
  rerender();
}

/** X on the rest screen (or any physical button): stop buzzing, on to the next set. */
function dismissRest() {
  stopBuzz();
  store.endRest();
  restOverAt = 0;
  syncRestAlarm();
  view = null;
  rerender();
}

function render() {
  clearAll();
  const v = view || autoView();
  try { scrollTo({ y: 0 }); } catch (e) { /* not scrollable */ }
  (VIEWS[v.name] || VIEWS.home)(v);
  if (toast) drawToast();
  keepAwake(!!store.session && !store.session.finishedAt);
}

function statusText() {
  const parts = [clock(store.elapsedSecs())];
  if (store.session && store.session.practice) parts.unshift('TRY');
  if (store.lastHr && Date.now() - store.lastHr.t < 20000) parts.push(`${store.lastHr.bpm} bpm`);
  const p = store.progress();
  parts.push(`${p.done}/${p.total}`);
  const over = restOverAt ? Math.round((Date.now() - restOverAt) / 1000) : 0;
  if (over > 0 && over < 600) parts.push(`rest +${clock(over)}`);
  return parts.join('  ');
}

function statusLine() {
  // Practice workouts: the status line turns gold and starts with TRY.
  ticking.status = text(110, 24, 260, 34, statusText(), 24, store.session && store.session.practice ? GOLD : MUTED);
  if (store.sync.ok === false || store.ops.length > 20) {
    text(150, 0, 180, 26, store.sync.ok === false ? 'phone offline' : `${store.ops.length} to send`, 18, GOLD);
  }
}

function drawToast() {
  const bg = add(widget.FILL_RECT, { x: px(40), y: py(12), w: px(400), h: px(104), radius: px(30), color: toast.gold ? GOLD_BG : TOAST_BG });
  const t1 = text(60, 18, 360, 46, toast.text, 30, toast.gold ? GOLD : WHITE);
  const t2 = toast.sub ? text(60, 62, 360, 40, toast.sub, 22, MUTED) : null;
  const onTap = () => {
    const a = toast && toast.action;
    toast = null;
    if (a) handleFeedback(a());
    rerender();
  };
  for (const w of [bg, t1, t2]) if (w) w.addEventListener(event.CLICK_UP, onTap);
}

const setLabel = (item) => {
  const k = item.row.kind;
  if (k === 'supplemental') return `5x5 ${item.sub + 1}/${item.row.sets}`;
  if (k === 'warmup') return 'warm-up';
  if (k === 'amrap') return 'AMRAP';
  return `${Math.round((item.row.pct || 0) * 100)}%`;
};

/** kg per side ((total - bar) / 2), the plates "20 5 2.5", and the change from the previous set ("-5 +10"). */
function plateLines(item) {
  const l = store.loadingOf(item);
  if (!l) return null;
  const perSide = (l.loading.total - BAR) / 2;
  const { remove, add: put } = plateSteps(l.prev, l.loading.perSide);
  const steps = [...remove.map((p) => `-${p}`), ...put.map((p) => `+${p}`)].join(' ');
  return {
    perSide,
    side: perSide > 0 ? `${kg(perSide)} / side` : 'empty bar',
    plates: `${l.loading.perSide.join(' ')}${l.loading.exact ? '' : ` (only ${kg(l.loading.total)})`}`,
    steps: steps ? `${steps} each side` : l.loading.perSide.length ? 'plates stay' : '',
    changed: !!steps,
  };
}

function nextLine() {
  const cur = store.current();
  if (!cur) return 'then: finish';
  if (cur.type === 'round') return `next: assistance round ${cur.round + 1}`;
  const p = store.planned(cur);
  const pl = plateLines(cur);
  return `next: ${kg(p.weight)}x${cur.row.reps}${pl && pl.changed ? `  ${pl.steps.replace(' each side', '')}` : ''}`;
}

const VIEWS = {
  home() {
    text(140, 30, 200, 40, envName ? `5/3/1 · ${envName}` : '5/3/1', 30, envName ? GOLD : MUTED);
    if (!store.pkg) {
      wrapText(60, 90, 360, 190, pkgLoading ? 'Loading your plan from the phone...' : pkgError || 'No plan yet.', 28, pkgError ? RED_T : WHITE);
      if (!pkgLoading) greenButton(110, 300, 260, 90, 'Retry', loadPackage, 36);
      return;
    }
    const c = store.cycle;
    const sug = store.suggestedDay();
    const d = picked || sug;
    if (!d) {
      wrapText(60, 110, 360, 120, `All AMRAPs in ${c.name} are logged. Set up the next cycle on the phone.`, 28);
      button(130, 300, 220, 60, 'Other day', () => setView({ name: 'days' }), { size: 26 });
      return;
    }
    text(40, 76, 400, 58, `Week ${d.week} · Day ${d.day}`, 46);
    text(40, 134, 400, 40, d.lifts, 30, ACCENT);
    if (!c.writable) {
      wrapText(60, 190, 360, 110, `Sheet layout not recognised; logging is off. ${c.layoutProblems[0] || ''}`, 22, RED_T);
    } else {
      greenButton(90, 190, 300, 110, 'START', () => {
        store.start(d.week, d.day);
        picked = null;
        view = null;
        lastSyncAt = 0;
        rerender();
      }, 50);
    }
    button(60, 314, 175, 56, picked ? 'Other day *' : 'Other day', () => setView({ name: 'days' }), { size: 24 });
    if (c.writable) {
      button(245, 314, 175, 56, 'Practice', () => {
        store.start(d.week, d.day, true);
        picked = null;
        view = null;
        rerender();
      }, { size: 24, textColor: GOLD });
    }
    const age = store.pkg.at ? `plan ${hhmm(Date.parse(store.pkg.at))}` : '';
    const syncTxt = pkgLoading ? 'updating...' : pkgError ? 'phone unreachable' : age;
    text(110, 382, 260, 30, syncTxt, 20, pkgError ? GOLD : MUTED);
    ticking.hr = text(150, 414, 180, 30, store.lastHr ? `${store.lastHr.bpm} bpm` : '', 20, MUTED);
  },

  days() {
    text(90, 20, 300, 40, 'Pick a day', 28, MUTED);
    const days = store.allDays();
    days.forEach((d, i) => {
      button(60, 70 + i * 70, 360, 60, `W${d.week} D${d.day}  ${d.lifts}${d.logged ? '  (done)' : ''}`, () => {
        picked = { week: d.week, day: d.day, lifts: d.lifts };
        back();
      }, { size: 22, color: d.logged ? 0x202020 : GRAY });
    });
    button(140, 80 + days.length * 70, 200, 56, 'Back', back, { size: 24 });
    add(widget.FILL_RECT, { x: 0, y: py(150 + days.length * 70), w: px(10), h: px(120), color: 0x000000 });
  },

  set({ item }) {
    statusLine();
    const p = store.planned(item);
    text(60, 60, 360, 40, `${liftName(item.liftRef).toUpperCase()} · ${setLabel(item)}`, 30, ACCENT);
    text(30, 96, 420, 92, `${kg(p.weight)}x${item.row.reps}`, 80);
    const pl = plateLines(item);
    if (pl) {
      text(40, 186, 400, 56, pl.side, 50);
      text(40, 244, 400, 36, [pl.perSide > 0 ? pl.plates : '', pl.steps].filter(Boolean).join('   '), 24, pl.changed ? GOLD : MUTED);
    }
    if (item.row.kind === 'amrap') {
      greenButton(90, 285, 300, 106, 'AMRAP >', () => setView({ name: 'amrap', item, reps: store.amrapInfo(item).start }), 42);
    } else {
      greenButton(90, 285, 300, 106, 'DONE', () => act(() => store.done(item)), 50);
    }
    button(128, 398, 110, 50, 'Edit', () => setView({ name: 'edit', item, weight: p.weight, reps: plannedReps(item.row) }), { size: 24 });
    button(242, 398, 110, 50, 'More', () => setView({ name: 'menu' }), { size: 24 });
  },

  round({ item }) {
    statusLine();
    const total = store.items().filter((it) => it.type === 'round').length;
    text(60, 60, 360, 40, `ASSISTANCE · ${item.round + 1}/${total}`, 30, ACCENT);
    const d = store.day();
    d.assistance.slice(0, 4).forEach((a, i) => {
      const logged = store.session.entries[`X:${a.index}`];
      const name = logged && logged.name ? logged.name : a.name;
      const w = logged && logged.weight != null ? logged.weight : typeof a.weight === 'number' ? a.weight : null;
      const reps = logged && logged.reps != null ? logged.reps : a.reps;
      text(50, 104 + i * 44, 380, 42, `${name}  ${w ? `${kg(w)}kg ` : ''}x${reps == null ? '?' : reps}`, 28);
    });
    greenButton(90, 285, 300, 106, 'DONE', () => act(() => store.done(item)), 50);
    button(185, 398, 110, 50, 'More', () => setView({ name: 'menu' }), { size: 24 });
  },

  rest() {
    const r = store.rest;
    const left = store.restLeft();
    const over = left <= 0;
    add(widget.ARC, { ...RING, end_angle: 270, color: over ? GOLD : 0x202020 });
    if (!over) ticking.arc = add(widget.ARC, { ...RING, end_angle: -90 + 360 * Math.max(0, left / r.total), color: GREEN });
    text(140, 62, 200, 36, over ? 'GO!' : 'REST', 28, over ? GOLD : MUTED);
    ticking.rest = text(60, 100, 360, 124, over ? `+${clock(-left)}` : clock(left), 112, over ? GOLD : WHITE);
    ticking.hr = text(120, 224, 240, 42, store.lastHr ? `${store.lastHr.bpm} bpm` : '', 32, RED_T);
    text(50, 262, 380, 38, nextLine(), 26, MUTED);
    if (over) {
      greenButton(90, 302, 300, 110, 'X', dismissRest, 64);
    } else {
      button(95, 312, 140, 100, '+30s', () => { store.addRest(30); syncRestAlarm(); rerender(); }, { size: 34 });
      greenButton(245, 312, 140, 100, 'X', dismissRest, 56);
    }
  },

  overview({ ov }) {
    if (ov.kind === 'assistance') {
      text(60, 50, 360, 40, `ASSISTANCE · ${ov.rounds}x`, 30, ACCENT);
      ov.rows.slice(0, 4).forEach((a, i) => {
        text(36, 96 + i * 48, 408, 44, `${a.name}  ${a.weight ? `${kg(a.weight)}kg ` : ''}x${a.reps == null ? '?' : a.reps}`, 26);
      });
    } else {
      text(60, 44, 360, 40, `${ov.name.toUpperCase()}${ov.tm ? `  TM ${kg(ov.tm)}` : ''}`, 28, ACCENT);
      if (ov.warmups.length) text(50, 84, 380, 32, `warm-up ${ov.warmups.map(kg).join(' ')}`, 24, MUTED);
      ov.main.forEach((m, i) => {
        text(30, 118 + i * 46, 420, 44, `${kg(m.weight)}x${m.reps}${m.perSide > 0 ? `   ${kg(m.perSide)}/side` : ''}`, 34);
      });
      if (ov.supplemental) {
        const sp = ov.supplemental;
        text(40, 258, 400, 34, `${sp.sets}x${sp.reps} at ${kg(sp.weight)}${sp.perSide > 0 ? `  ${kg(sp.perSide)}/side` : ''}`, 26, MUTED);
      }
    }
    greenButton(90, 300, 300, 96, 'START', () => dismissOverview(ov), 44);
    button(185, 402, 110, 48, 'More', () => setView({ name: 'menu' }), { size: 22 });
  },

  amrap(v) {
    const info = store.amrapInfo(v.item);
    const weight = v.weight != null ? v.weight : info.weight;
    text(40, 26, 400, 40, `AMRAP ${liftName(v.item.liftRef)} ${kg(weight)}`, 28, ACCENT);
    const count = text(145, 80, 190, 140, String(v.reps), 112);
    const est = text(60, 222, 360, 38, '', 30);
    const hint = text(50, 260, 380, 36, '', 22, MUTED);
    const update = () => {
      count.setProperty(prop.TEXT, String(v.reps));
      const e = e1rm(weight, v.reps);
      const pr = info.best && e > info.best.e1rm;
      est.setProperty(prop.MORE, { text: `e1RM ${kg1(e)}${pr ? '  PR!' : ''}`, color: pr ? GOLD : WHITE });
      const ahead = info.targets.filter((t) => t.reps > v.reps).slice(0, 2);
      hint.setProperty(prop.TEXT, ahead.length ? ahead.map((t) => `${t.reps}: ${t.label}`).join(' · ') : 'every target hit');
    };
    button(28, 90, 112, 124, '-', () => { v.reps = Math.max(0, v.reps - 1); buzz(VIBRATOR_SCENE_SHORT_LIGHT); update(); }, { size: 64 });
    button(340, 90, 112, 124, '+', () => { v.reps += 1; buzz(VIBRATOR_SCENE_SHORT_LIGHT); update(); }, { size: 64 });
    update();
    greenButton(90, 304, 300, 96, 'Save', () => { view = null; act(() => store.logSet(v.item, weight, v.reps)); }, 40);
    button(128, 408, 110, 48, 'Skip', () => { view = null; act(() => store.skip(v.item)); }, { size: 22 });
    button(242, 408, 110, 48, 'Back', back, { size: 22 });
  },

  edit(v) {
    text(100, 24, 280, 40, v.item.row.kind === 'amrap' ? 'AMRAP weight' : 'Change set', 28, ACCENT);
    stepper(v, 'weight', 80, 2.5, (x) => `${kg(x)} kg`);
    if (v.item.row.kind !== 'amrap') stepper(v, 'reps', 180, 1, (x) => `${x} reps`);
    greenButton(90, 285, 300, 84, 'Save', () => {
      view = null;
      if (v.item.row.kind === 'amrap') setView({ name: 'amrap', item: v.item, reps: store.amrapInfo(v.item).start, weight: v.weight });
      else act(() => store.logSet(v.item, v.weight, v.reps));
    }, 38);
    redButton(118, 380, 118, 56, 'Skip set', () => { view = null; act(() => store.skip(v.item)); }, 24);
    button(244, 380, 118, 56, 'Cancel', back, { size: 24 });
  },

  extra(v) {
    const groups = store.groups().filter((g) => g.group !== 'A');
    const g = groups.find((x) => x.group === v.group) || groups[0];
    button(110, 20, 260, 52, `Extra: ${g.name}`, () => {
      const i = groups.indexOf(g);
      v.group = groups[(i + 1) % groups.length].group;
      rerender();
    }, { size: 24 });
    stepper(v, 'weight', 80, 2.5, (x) => `${kg(x)} kg`);
    stepper(v, 'reps', 180, 1, (x) => `${x} reps`);
    greenButton(90, 285, 300, 84, 'Add set', () => { view = null; act(() => { store.addExtra(g.group, v.weight, v.reps); return null; }); }, 36);
    button(170, 380, 140, 56, 'Cancel', back, { size: 24 });
  },

  menu() {
    const items = [];
    if (store.lastAction) items.push(['Undo last', () => { view = null; act(() => store.undo()); }]);
    items.push(['Go to...', () => setView({ name: 'goto', parent: view })]);
    const cur = store.current();
    const groups = store.groups();
    const g = cur ? groupOf(cur) : null;
    const paused = groups.filter((x) => x.paused);
    if (g) items.push([`Pause ${groups.find((x) => x.group === g).name}`, () => { store.togglePause(g); setView(null); }]);
    for (const x of paused) items.push([`Resume ${x.name}`, () => { store.togglePause(x.group); setView(null); }]);
    if (store.order().length > 1) items.push(['Swap lift order', () => { store.swapOrder(); setView(null); }]);
    const lastLift = cur && cur.type === 'set' ? cur : store.items().filter((it) => it.type === 'set' && store.entry(it)).pop();
    items.push(['Extra set', () => {
      const w = lastLift ? store.planned(lastLift).weight : BAR;
      setView({ name: 'extra', parent: view, group: lastLift ? groupOf(lastLift) : 'L1', weight: w, reps: 5 });
    }]);
    if (groups.some((x) => x.group === 'A')) {
      const n = store.items().filter((it) => it.type === 'round').length;
      items.push([`Rounds ${n}: add one`, () => { store.setRounds(n + 1); rerender(); }]);
      items.push([`Rounds ${n}: remove one`, () => { store.setRounds(n - 1); rerender(); }]);
    }
    items.push(['Plates', () => setView({ name: 'plates', parent: view })]);
    items.push(['Finish workout', () => confirm('Finish the workout?', () => { store.finish(); lastSyncAt = 0; })]);
    const practice = store.session && store.session.practice;
    items.push([practice ? 'End practice' : 'Leave workout', () => confirm(practice ? 'End the practice run? Nothing was saved.' : 'Leave without finishing? Logged sets stay in the sheet.', () => { store.leave(); lastSyncAt = 0; })]);
    text(140, 16, 200, 40, 'Menu', 28, MUTED);
    items.forEach(([label, fn], i) => button(70, 64 + i * 72, 340, 62, label, fn, {
      size: 26, color: /^(Leave|End)/.test(label) ? RED : label.startsWith('Finish') ? GREEN : GRAY,
      press: /^(Leave|End)/.test(label) ? RED_P : label.startsWith('Finish') ? GREEN_P : GRAY_P,
    }));
    const y = 64 + items.length * 72;
    button(150, y, 180, 56, 'Back', back, { size: 24 });
    add(widget.FILL_RECT, { x: 0, y: py(y + 60), w: px(10), h: px(120), color: 0x000000 }); // room to scroll the last button up
  },

  goto() {
    text(120, 20, 240, 40, 'Do next', 28, MUTED);
    const groups = store.groups();
    groups.forEach((g, i) => {
      const label = `${g.name}  ${g.done}/${g.total}${g.paused ? ' (paused)' : ''}`;
      button(60, 80 + i * 80, 360, 68, label, () => {
        if (g.next) store.doNext(g.next);
        setView(null);
      }, { size: 26, color: g.next ? GRAY : 0x202020 });
    });
    button(150, 90 + groups.length * 80, 180, 56, 'Back', back, { size: 24 });
  },

  plates() {
    text(90, 20, 300, 40, 'Plates free (pairs)', 26, MUTED);
    const inv = store.inventory.value;
    [20, 15, 10, 5, 2.5, 1.25].forEach((p, i) => {
      const n = inv[p] || 0;
      button(i % 2 ? 245 : 85, 76 + Math.floor(i / 2) * 84, 150, 72, `${p}  x${n}`, () => {
        store.setInventory({ ...inv, [p]: (n + 1) % 5 });
        lastSyncAt = 0;
        rerender();
      }, { size: 28, color: n ? GRAY : 0x1a1a1a, textColor: n ? WHITE : MUTED });
    });
    greenButton(140, 340, 200, 70, 'Done', back, 30);
  },

  confirm(v) {
    wrapText(60, 90, 360, 150, v.text, 30);
    greenButton(90, 260, 300, 84, 'Yes', () => { view = null; v.onYes(); rerender(); }, 36);
    button(150, 356, 180, 60, 'No', back, { size: 26 });
  },

  alldone() {
    statusLine();
    const left = store.items().some((it) => !store.entry(it));
    text(40, 110, 400, 60, left ? 'Only paused left' : 'All done!', 44);
    greenButton(90, 200, 300, 100, 'Finish', () => { store.finish(); lastSyncAt = 0; rerender(); }, 42);
    button(150, 320, 180, 60, 'More', () => setView({ name: 'menu' }), { size: 26 });
  },

  summary(v) {
    const sum = store.summary();
    const rpe = v.rpe != null ? v.rpe : store.session.rpe;
    let y = 30;
    text(90, y, 300, 50, 'Workout done', 38); y += 56;
    text(40, y, 400, 40, `${Math.round(sum.secs / 60)} min · ${Math.round(sum.tonnage)} kg moved`, 28); y += 40;
    text(40, y, 400, 34, `${sum.done} done · ${sum.changed} changed · ${sum.skipped} skipped`, 22, MUTED); y += 38;
    if (sum.hr) { text(40, y, 400, 36, `HR avg ${sum.hr.avg} · max ${sum.hr.max}`, 26, RED_T); y += 40; }
    for (const a of sum.amraps) {
      const line = a.skipped ? `${a.name}: AMRAP skipped` : `${a.name} ${kg(a.weight)}x${a.reps}  e1RM ${kg1(a.e1rm)}${a.pr ? '  PR!' : a.repPr ? '  rep PR' : ''}`;
      text(30, y, 420, 36, line, 24, a.pr || a.repPr ? GOLD : WHITE); y += 38;
    }
    y += 6;
    text(90, y, 300, 34, 'How hard was it?', 24, MUTED); y += 40;
    [5, 6, 7, 8, 9, 10].forEach((n, i) => {
      const sel = rpe === n;
      button(80 + (i % 3) * 110, y + Math.floor(i / 3) * 72, 100, 62, String(n), () => {
        const s = { ...(view || { name: 'summary' }), name: 'summary', rpe: sel ? null : n };
        buzz(VIBRATOR_SCENE_SHORT_LIGHT);
        setView(s);
      }, { size: 30, color: sel ? GREEN : GRAY, press: sel ? GREEN_P : GRAY_P });
    });
    y += 150;
    greenButton(90, y, 300, 84, 'Save & close', () => {
      view = null;
      store.close(rpe == null ? null : rpe);
      lastSyncAt = 0;
      rerender();
    }, 32);
    add(widget.FILL_RECT, { x: 0, y: py(y + 90), w: px(10), h: px(100), color: 0x000000 });
  },

  missing() {
    wrapText(60, 100, 360, 160, 'This workout is not in the plan the phone sent. Leave it?', 28);
    redButton(120, 290, 240, 80, 'Leave', () => { store.leave(); lastSyncAt = 0; rerender(); }, 30);
  },
};

function stepper(v, key, y, step, fmt) {
  const value = text(140, y, 200, 90, fmt(v[key]), 40);
  const change = (d) => {
    v[key] = Math.max(0, +(v[key] + d).toFixed(2));
    value.setProperty(prop.TEXT, fmt(v[key]));
    buzz(VIBRATOR_SCENE_SHORT_LIGHT);
  };
  button(40, y, 100, 90, '-', () => change(-step), { size: 50 });
  button(340, y, 100, 90, '+', () => change(step), { size: 50 });
}

function confirm(textStr, onYes) {
  setView({ name: 'confirm', text: textStr, onYes, parent: view });
}

// ---------- actions and feedback ----------

/** Run a store action, give feedback, and go back to the automatic screen. */
function act(fn) {
  buzz(VIBRATOR_SCENE_SHORT_LIGHT);
  restOverAt = 0;
  const fb = fn();
  handleFeedback(fb, true);
  syncRestAlarm();
  lastSyncAt = Math.min(lastSyncAt, Date.now() - 3000); // send soon
  view = null;
  rerender();
}

function handleFeedback(fb, offerUndo = false) {
  if (fb && fb.kind === 'pr') {
    buzz(VIBRATOR_SCENE_DURATION_LONG);
    showToast({ text: fb.text, sub: fb.sub, gold: true }, 6000);
  } else if (fb && (fb.kind === 'double' || fb.kind === 'missed')) {
    buzz(VIBRATOR_SCENE_SHORT_MIDDLE);
    showToast({ text: fb.text, sub: fb.sub, action: fb.action }, 9000);
  } else if (fb && fb.kind === 'info') {
    showToast({ text: fb.text, sub: fb.sub }, 5000);
  } else if (offerUndo && store.lastAction) {
    showToast({ text: 'Logged', sub: 'tap here to undo', action: () => store.undo() }, 3500);
  }
}

// ---------- rest timer: in-page countdown plus a system alarm as backup ----------

/** Keeps one alarm matching the rest timer, so the watch still buzzes if the app was closed. */
function syncRestAlarm() {
  const r = store.rest;
  if (restAlarm.id && (!r || r.endsAt !== restAlarm.endsAt)) {
    try { cancelAlarm(restAlarm.id); } catch (e) { /* already fired */ }
    restAlarm = { id: 0, endsAt: 0 };
  }
  if (r && !restAlarm.id && r.endsAt > Date.now() + 5000) {
    try {
      // A few seconds late on purpose: if the app is still open it ends the rest itself and cancels this.
      const id = setAlarm({ url: 'page/index', delay: Math.ceil((r.endsAt - Date.now()) / 1000) + 3, param: 'rest' });
      restAlarm = { id: id || 0, endsAt: r.endsAt };
    } catch (e) {
      logger.log(`alarm failed ${e}`);
    }
  }
}

function tick() {
  const now = Date.now();
  if (store.rest) {
    const left = store.restLeft();
    if (left <= 10 && left > 0 && warnedFor !== store.rest.endsAt) {
      warnedFor = store.rest.endsAt;
      buzz(VIBRATOR_SCENE_SHORT_MIDDLE);
    }
    if (left < -600) {
      // Ran out 10+ minutes ago (app closed meanwhile): drop it quietly.
      dismissRest();
    } else if (left <= 0) {
      // Time's up: stay on the rest screen and buzz every few seconds until X, for at most 2 minutes.
      if (!restOverAt) {
        restOverAt = now;
        restBuzzAt = now;
        buzz(VIBRATOR_SCENE_STRONG_REMINDER);
        syncRestAlarm();
        if (!view) render();
      } else if (now - restOverAt < REST_BUZZ_MAX_MS && now - restBuzzAt >= REST_BUZZ_EVERY_MS) {
        restBuzzAt = now;
        buzz(VIBRATOR_SCENE_STRONG_REMINDER);
      } else if (now - restOverAt >= REST_BUZZ_MAX_MS && restBuzzAt) {
        restBuzzAt = 0;
        stopBuzz();
      }
      if (ticking.rest) ticking.rest.setProperty(prop.TEXT, `+${clock(-left)}`);
    } else {
      if (ticking.rest) ticking.rest.setProperty(prop.TEXT, clock(left));
      if (ticking.arc) ticking.arc.setProperty(prop.MORE, { ...RING, end_angle: -90 + 360 * Math.max(0, left / store.rest.total), color: GREEN });
    }
  }
  if (toast && now > toast.until) {
    toast = null;
    render();
  }
  if (ticking.status) ticking.status.setProperty(prop.TEXT, statusText());
  if (ticking.hr) ticking.hr.setProperty(prop.TEXT, store.lastHr && now - store.lastHr.t < 20000 ? `${store.lastHr.bpm} bpm` : '');
  const every = store.session || store.ops.length || store.pendingClose ? 5000 : 20000;
  if (now - lastSyncAt >= every) syncNow();
}

// ---------- phone ----------

const errText = (e) => String((e && (e.message || (e.data && e.data.message))) || e || 'phone not reachable');

function syncNow() {
  if (syncing || !page) return;
  syncing = true;
  lastSyncAt = Date.now();
  const req = store.syncRequest();
  page.request({ method: 'sync', params: req }, { timeout: 30000 })
    .then((res) => {
      syncing = false;
      const ev = store.applySync(req, res);
      if (ev && ev.type === 'closed-elsewhere') { view = null; showToast({ text: 'Workout closed', sub: 'on the phone' }); }
      else if (ev && ev.type === 'joined') { view = null; showToast({ text: 'Workout from phone', sub: 'carrying on here' }); }
      else if (ev && !view) rerender();
    })
    .catch((e) => {
      syncing = false;
      const wasOk = store.sync.ok !== false;
      store.syncFailed(errText(e));
      if (wasOk) rerender();
    });
}

function loadPackage() {
  if (!page || pkgLoading) return;
  pkgLoading = true;
  rerender();
  page.request({ method: 'status', params: {} }, { timeout: 15000 })
    .then((st) => { envName = st && st.name ? st.name : null; })
    .catch(() => {});
  page.request({ method: 'package', params: {} }, { timeout: 90000 })
    .then((pkg) => {
      store.setPackage(pkg);
      pkgError = null;
      pkgLoading = false;
      if (!store.session) rerender();
    })
    .catch((e) => {
      pkgError = errText(e);
      pkgLoading = false;
      if (!store.session) rerender();
    });
}

// ---------- screen, keys ----------

function keepAwake(on) {
  if (awake === on) return;
  awake = on;
  try {
    if (on) {
      setPageBrightTime({ brightTime: 4 * 3600 * 1000 });
      pauseDropWristScreenOff({ duration: 0 });
      setWakeUpRelaunch({ relaunch: true });
    } else {
      resetPageBrightTime();
      resetDropWristScreenOff();
      setWakeUpRelaunch({ relaunch: false });
    }
  } catch (e) {
    logger.log(`keepAwake failed ${e}`);
  }
}

/** Physical buttons: the main action of whatever is on screen, so you don't have to aim. */
function primary() {
  const v = view || autoView();
  if (v.name === 'set' && v.item.row.kind !== 'amrap') { act(() => store.done(v.item)); return true; }
  if (v.name === 'set') { setView({ name: 'amrap', item: v.item, reps: store.amrapInfo(v.item).start }); return true; }
  if (v.name === 'round') { act(() => store.done(v.item)); return true; }
  if (v.name === 'rest') { dismissRest(); return true; }
  if (v.name === 'overview') { dismissOverview(v.ov); return true; }
  if (v.name === 'amrap') {
    const info = store.amrapInfo(v.item);
    view = null;
    act(() => store.logSet(v.item, v.weight != null ? v.weight : info.weight, v.reps));
    return true;
  }
  return false;
}

function onBack() {
  if (view) { back(); return true; }
  if (store.session) { setView({ name: 'menu' }); return true; }
  return false;
}

Page(
  BasePage({
    onInit(params) {
      page = this;
      if (params && String(params).indexOf('rest') >= 0) {
        // Reopened by the backup alarm: show the rest screen, buzzing, until X.
        buzz(VIBRATOR_SCENE_STRONG_REMINDER);
        restOverAt = Date.now();
        restBuzzAt = restOverAt;
      }
    },

    build() {
      page = this;
      try { setScrollMode({ mode: SCROLL_MODE_FREE }); } catch (e) { /* older firmware */ }
      try {
        heart = new HeartRate();
        const onHr = () => store.addHr(heart.getCurrent());
        heart.onCurrentChange(onHr);
        this.onHr = onHr;
        const last = heart.getLast();
        if (last) store.addHr(last);
      } catch (e) {
        logger.log(`heart rate unavailable ${e}`);
      }
      onKey({
        callback: (key, ev) => {
          logger.log(`key ${key} event ${ev}`);
          if (ev !== KEY_EVENT_CLICK) return false;
          if (key === KEY_BACK) return onBack();
          if (!store.session) return false;
          if (key === KEY_SELECT || key === KEY_UP || key === KEY_DOWN || key === KEY_SHORTCUT) return primary();
          return false;
        },
      });
      onGesture({
        callback: (g) => (g === GESTURE_RIGHT && (view || store.session) ? onBack() : false),
      });
      render();
      syncRestAlarm();
      if (!store.session || !store.pkg) loadPackage();
      timer = setInterval(tick, 1000);
    },

    onDestroy() {
      if (timer) clearInterval(timer);
      try { offKey(); offGesture(); } catch (e) { /* ignore */ }
      if (heart && this.onHr) heart.offCurrentChange(this.onHr);
      if (vibrator) vibrator.stop();
      keepAwake(false);
      page = null;
    },
  }),
);
