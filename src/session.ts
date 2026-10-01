// A workout in progress: the ordered list of things to do, what has been done,
// and the sheet ops each action produces. Kept in localStorage so a reload or
// a dead battery mid-session loses nothing.

import type { Cycle, Day, Lift, LiftKey, SetRow } from './api.ts';
import { mround, supplementalPct } from './stats.ts';

/** 'open' marks an item undone in this session, overriding a stale "done" from the last sheet read. */
export type Status = 'done' | 'changed' | 'skipped' | 'open';

export interface Entry {
  status: Status; weight?: number; reps?: number; note?: string; name?: string; at: string;
  /** Assistance round: what each exercise actually got, when it differs from the plan. */
  detail?: { index: number; reps: number | string | null }[];
  /** Heart rate from the watch: at the tap, highest and lowest since the previous completion. */
  hr?: HrMarks;
}

export interface HrMarks { done?: number; peak?: number; low?: number; avg?: number }

/** A set that isn't in the sheet plan (an extra 5x5, a back-off set, a 6th round). Session log only. */
export interface Extra { id: string; group: string; label: string; weight?: number; reps?: number; note?: string; at: string }

export interface Session {
  cycle: string;
  week: number;
  day: number;
  date: string; // yyyy-mm-dd
  startedAt: string;
  entries: Record<string, Entry>;
  finishedAt?: string;
  /** Sheet lift indexes (0/1) in the order they are done today. */
  liftOrder?: number[];
  /** Last item done out of order: "next" continues after it instead of jumping back. */
  cursor?: string;
  /** Groups ('L1', 'L2', 'A') set aside for now; they don't become current until resumed. */
  paused?: string[];
  /** Assistance rounds today, if not the sheet's 5. */
  roundCount?: number;
  extras?: Extra[];
  /** Extras removed on some device; kept so a sync doesn't bring them back. */
  removedExtras?: string[];
  rpe?: number;
  /** Heart rate over the whole workout so far (watch only). */
  hr?: { avg: number; max: number; min: number; samples: number };
  /** A try-out: nothing goes to the sheet and it isn't shared with the other device. */
  practice?: boolean;
  /** When each non-set field last changed, for merging copies from phone and watch (see live.ts). */
  stamps?: Partial<Record<string, string>>;
}

export type Item =
  | { id: string; type: 'set'; lift: 1 | 2; set: number; sub: number; row: SetRow; liftRef: Lift }
  | { id: string; type: 'round'; round: number };

const SESSION_KEY = 'session';

export function loadSession(): Session | null {
  const raw = localStorage.getItem(SESSION_KEY);
  return raw ? (JSON.parse(raw) as Session) : null;
}

export function saveSession(s: Session | null): void {
  if (s) localStorage.setItem(SESSION_KEY, JSON.stringify(s));
  else localStorage.removeItem(SESSION_KEY);
}

export function localDate(d = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function newSession(cycle: Cycle, week: number, day: number, practice = false): Session {
  const d = findDay(cycle, week, day);
  return {
    cycle: cycle.name, week, day, date: localDate(), startedAt: new Date().toISOString(), entries: {},
    liftOrder: d ? defaultLiftOrder(d) : undefined,
    ...(practice ? { practice: true } : {}),
  };
}

const EARLY_START_SECS = 15 * 60;
const FIRST_SET_SECS = 90;

function completionTimes(session: Session, excludeId?: string): string[] {
  const out: string[] = [];
  for (const [id, e] of Object.entries(session.entries)) {
    if (id !== excludeId && e.status !== 'open' && e.at) out.push(e.at);
  }
  for (const x of session.extras ?? []) if (x.id !== excludeId) out.push(x.at);
  return out.sort();
}

/**
 * When the workout really started. Tapping Start at home and lifting an hour later
 * shouldn't count as an hour-long first set: if the first completion comes more
 * than 15 min after Start, the workout is taken to begin 90 s before it.
 */
export function effectiveStart(session: Session, firstAt = completionTimes(session)[0]): string {
  if (!firstAt) return session.startedAt;
  const gap = (Date.parse(firstAt) - Date.parse(session.startedAt)) / 1000;
  return gap > EARLY_START_SECS ? new Date(Date.parse(firstAt) - FIRST_SET_SECS * 1000).toISOString() : session.startedAt;
}

/** When the last thing before `at` was completed in this session (or the workout start). */
export function previousCompletion(session: Session, at: string, excludeId?: string): string {
  const times = completionTimes(session, excludeId);
  const before = times.filter((t) => t < at);
  return before.length ? before[before.length - 1] : effectiveStart(session, [...times, at].sort()[0]);
}

export function timing(session: Session, at: string, id: string): { doneAt: string; secsSincePrevious: number; secsSinceStart: number } {
  const secs = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 1000);
  const start = effectiveStart(session, [...completionTimes(session, id), at].sort()[0]);
  return { doneAt: at, secsSincePrevious: secs(previousCompletion(session, at, id), at), secsSinceStart: secs(start, at) };
}

/** kg moved in this session (weight x reps of every logged barbell set). */
export function tonnage(items: Item[], session: Session): number {
  let t = 0;
  for (const it of items) {
    const e = session.entries[it.id];
    if (it.type !== 'set' || !e || e.status === 'open' || e.status === 'skipped') continue;
    t += (e.weight ?? it.row.weight) * (e.reps ?? plannedReps(it.row));
  }
  for (const x of session.extras ?? []) if (x.group !== 'A') t += (x.weight ?? 0) * (x.reps ?? 0);
  return t;
}

export function findDay(cycle: Cycle, week: number, day: number): Day | null {
  return cycle.weeks.find((w) => w.week === week)?.days.find((d) => d.day === day) ?? null;
}

/** Squat goes first when the day has it; otherwise the sheet order. */
export function defaultLiftOrder(day: Day): number[] {
  const squat = day.lifts.findIndex((l) => l.key === 'squat');
  return squat > 0 ? [squat, ...day.lifts.map((_, i) => i).filter((i) => i !== squat)] : day.lifts.map((_, i) => i);
}

/** Everything in the workout, in the order it is done. Item ids keep the sheet's lift numbers. */
export function buildItems(day: Day, order = day.lifts.map((_, i) => i), rounds = day.rounds.length): Item[] {
  const items: Item[] = [];
  order.forEach((li) => {
    const lift = day.lifts[li];
    const n = (li + 1) as 1 | 2;
    for (const row of lift.sets) {
      const subs = row.kind === 'supplemental' ? Math.max(1, row.sets || 5) : 1;
      for (let sub = 0; sub < subs; sub++) {
        items.push({ id: `L${n}:${row.index}${subs > 1 ? '.' + sub : ''}`, type: 'set', lift: n, set: row.index, sub, row, liftRef: lift });
      }
    }
  });
  if (day.assistance.length) {
    for (let r = 0; r < rounds; r++) items.push({ id: `A:${r}`, type: 'round', round: r });
  }
  return items;
}

/** What the sheet already says about an item (done before this session, or on another device). */
export function sheetEntry(item: Item, day: Day): Entry | null {
  if (item.type === 'round') return day.rounds[item.round] ? { status: 'done', at: '' } : null; // rounds past the sheet's 5 are never pre-done
  const { row, sub } = item;
  if (row.kind === 'amrap') return row.actual != null ? { status: 'done', reps: row.actual, weight: row.weight, at: '' } : null;
  const done = Array.isArray(row.done) ? row.done[sub] : row.done;
  return done ? { status: 'done', at: '' } : null;
}

export function entryFor(item: Item, session: Session, day: Day): Entry | null {
  const e = session.entries[item.id];
  if (e) return e.status === 'open' ? null : e;
  return sheetEntry(item, day);
}

export function groupOf(item: Item): string {
  return item.type === 'set' ? `L${item.lift}` : 'A';
}

/**
 * The next thing to do. After you jump into an exercise (the cursor), it stays with
 * that exercise until it's finished or paused; then it's the first open item from
 * the top. Paused groups are passed over.
 */
export function currentItem(items: Item[], session: Session, day: Day): Item | null {
  const open = (it: Item) => !entryFor(it, session, day) && !session.paused?.includes(groupOf(it));
  const from = session.cursor ? items.findIndex((it) => it.id === session.cursor) : -1;
  if (from >= 0) {
    const group = groupOf(items[from]);
    const after = items.slice(from).find((it) => open(it) && groupOf(it) === group);
    if (after) return after;
  }
  return items.find(open) ?? null;
}

export type TimingWarning =
  | { kind: 'double'; secs: number }
  | { kind: 'missed'; secs: number; next: Item };

/**
 * Sanity check on a completion: two sets a few seconds apart look like a double tap;
 * a long gap before a set that repeats (5x5, assistance rounds) looks like a set
 * done without tapping.
 */
export function timingWarning(item: Item, secsSincePrevious: number, items: Item[], session: Session, day: Day): TimingWarning | null {
  const working = item.type === 'round' || item.row.kind !== 'warmup';
  if (working && secsSincePrevious < 10) return { kind: 'double', secs: secsSincePrevious };
  const repeats = item.type === 'round' || item.row.kind === 'supplemental';
  const limit = Math.max(6 * 60, 2 * (restFor(item) + 90));
  if (repeats && secsSincePrevious > limit) {
    const i = items.indexOf(item);
    const next = items.slice(i + 1).find((it) => !entryFor(it, session, day) && groupOf(it) === groupOf(item));
    if (next && (next.type === 'round' || (item.type === 'set' && next.type === 'set' && next.set === item.set))) {
      return { kind: 'missed', secs: secsSincePrevious, next };
    }
  }
  return null;
}

/** Planned weight, with the 5x5 following today's AMRAP like the sheet formula does. */
export function plannedWeight(item: Item & { type: 'set' }, session: Session, day: Day, tm: Partial<Record<LiftKey, number>>): number {
  const { row, liftRef } = item;
  if (row.kind !== 'supplemental' || !liftRef.key || tm[liftRef.key] == null) return row.weight;
  const amrapRow = liftRef.sets.find((s) => s.kind === 'amrap');
  const amrapItemId = `L${item.lift}:${amrapRow?.index}`;
  const reps = session.entries[amrapItemId]?.reps ?? amrapRow?.actual;
  if (reps == null) return row.weight;
  const mainPcts = liftRef.sets.filter((s) => s.kind === 'main' || s.kind === 'amrap').map((s) => s.pct ?? 0);
  return mround(supplementalPct(reps, mainPcts) * tm[liftRef.key]!);
}

export function plannedReps(row: SetRow): number {
  return parseInt(row.reps, 10) || 0;
}

/** Default rest after an item, in seconds. */
export function restFor(item: Item): number {
  if (item.type === 'round') return 90;
  switch (item.row.kind) {
    case 'warmup': return 60;
    case 'supplemental': return 120;
    default: return 180;
  }
}

export interface Op { id: string; type: string; [k: string]: unknown }

/** Random id. The watch and plain-http pages have no crypto.randomUUID; ids only need to be unique. */
export function uuid(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (ch) => {
    const r = (Math.random() * 16) | 0;
    return (ch === 'x' ? r : (r & 3) | 8).toString(16);
  });
}

const opId = uuid;

export function setOp(item: Item & { type: 'set' }, session: Session, entry: Entry | null, planned: { weight: number; reps: string }): Op {
  return {
    id: opId(),
    type: 'set',
    cycle: session.cycle, week: session.week, day: session.day,
    lift: item.lift, set: item.set, sub: item.sub,
    status: entry ? entry.status : 'undo',
    actualWeight: entry?.weight ?? null,
    actualReps: entry?.reps ?? null,
    note: entry?.note ?? '',
    planned,
    exercise: item.liftRef.key ?? item.liftRef.name,
    sessionDate: session.date,
    hr: entry?.hr,
    ...(entry?.at ? timing(session, entry.at, item.id) : {}),
  };
}

/** Sheet has 5 round checkboxes; rounds beyond that go to the session log only. */
export function roundOp(round: number, session: Session, entry: Entry | null, sheetRounds: number): Op {
  const note = entry?.detail?.map((d) => `#${d.index + 1}: ${d.reps}`).join(', ') ?? '';
  return {
    id: opId(), type: round < sheetRounds ? 'assist_round' : 'extra',
    kind: round < sheetRounds ? undefined : 'assistance round',
    cycle: session.cycle, week: session.week, day: session.day,
    index: round, done: !!entry, status: entry ? 'done' : 'undo', note, sessionDate: session.date, hr: entry?.hr,
    ...(entry?.at ? timing(session, entry.at, `A:${round}`) : {}),
  };
}

export function extraOp(x: Extra, session: Session, exercise: string, removed = false): Op {
  return {
    id: opId(), type: 'extra', kind: x.group === 'A' ? 'assistance extra' : 'extra set', slot: x.group,
    cycle: session.cycle, week: session.week, day: session.day,
    exercise, actualWeight: x.weight ?? null, actualReps: x.reps ?? null,
    status: removed ? 'undo' : 'done', note: [x.label, x.note].filter(Boolean).join(' · '), sessionDate: session.date,
    ...(removed ? {} : timing(session, x.at, x.id)),
  };
}

/** One row summing up the workout: total time, kg moved, perceived effort. */
export function summaryOp(session: Session, totals: { secs: number; tonnage: number }, rpe: number | null, note: string): Op {
  return {
    id: `summary-${session.cycle}-w${session.week}d${session.day}-${session.date}-${session.startedAt}`,
    type: 'extra', kind: 'workout summary', slot: 'workout',
    cycle: session.cycle, week: session.week, day: session.day,
    exercise: 'workout', actualWeight: Math.round(totals.tonnage), actualReps: rpe,
    status: 'done', note: [rpe != null ? `RPE ${rpe}` : '', note].filter(Boolean).join(' · '), sessionDate: session.date,
    doneAt: session.finishedAt, secsSinceStart: Math.round(totals.secs),
    hr: session.hr ? { peak: session.hr.max, low: session.hr.min, avg: session.hr.avg } : undefined,
  };
}

export function assistOp(
  session: Session, index: number, name: string,
  values: { weight: number | null; reps: number | string | null; note?: string },
): Op {
  return {
    id: opId(), type: 'assist',
    cycle: session.cycle, week: session.week, day: session.day,
    index, exercise: name, actualWeight: values.weight, actualReps: values.reps,
    status: 'done', note: values.note ?? '', sessionDate: session.date,
  };
}

/** One rm calc row for the session: the AMRAP of each lift, at the weight actually lifted. */
export function rmOp(items: Item[], session: Session, day: Day): Op | null {
  const lifts: Partial<Record<LiftKey, { weight: number; reps: number }>> = {};
  for (const it of items) {
    if (it.type !== 'set' || it.row.kind !== 'amrap' || !it.liftRef.key) continue;
    const e = entryFor(it, session, day);
    if (e && e.status !== 'skipped' && e.reps != null) lifts[it.liftRef.key] = { weight: e.weight ?? it.row.weight, reps: e.reps };
  }
  if (Object.keys(lifts).length === 0) return null;
  return { id: `rm-${session.cycle}-w${session.week}d${session.day}-${session.date}`, type: 'rm', sessionDate: session.date, lifts };
}

/** Assistance weight/reps set ahead of a workout (from the Today screen's planner). */
export function assistPlanOp(
  cycle: string, week: number, day: number, index: number, name: string,
  values: { weight: number | null; reps: number | string | null },
): Op {
  return {
    id: opId(), type: 'assist', kind: 'assistance plan',
    cycle, week, day, index, exercise: name, actualWeight: values.weight, actualReps: values.reps,
    status: 'planned', note: '', sessionDate: localDate(),
  };
}
