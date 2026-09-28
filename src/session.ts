// A workout in progress: the ordered list of things to do, what has been done,
// and the sheet ops each action produces. Kept in localStorage so a reload or
// a dead battery mid-session loses nothing.

import type { Cycle, Day, Lift, LiftKey, SetRow } from './api.ts';
import { mround, supplementalPct } from './stats.ts';

/** 'open' marks an item undone in this session, overriding a stale "done" from the last sheet read. */
export type Status = 'done' | 'changed' | 'skipped' | 'open';

export interface Entry { status: Status; weight?: number; reps?: number; note?: string; name?: string; at: string }

export interface Session {
  cycle: string;
  week: number;
  day: number;
  date: string; // yyyy-mm-dd
  startedAt: string;
  entries: Record<string, Entry>;
  finishedAt?: string;
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

export function newSession(cycle: Cycle, week: number, day: number): Session {
  return { cycle: cycle.name, week, day, date: localDate(), startedAt: new Date().toISOString(), entries: {} };
}

export function findDay(cycle: Cycle, week: number, day: number): Day | null {
  return cycle.weeks.find((w) => w.week === week)?.days.find((d) => d.day === day) ?? null;
}

/** Everything in the workout, in the order it is done. */
export function buildItems(day: Day): Item[] {
  const items: Item[] = [];
  day.lifts.forEach((lift, li) => {
    const n = (li + 1) as 1 | 2;
    for (const row of lift.sets) {
      const subs = row.kind === 'supplemental' ? Math.max(1, row.sets || 5) : 1;
      for (let sub = 0; sub < subs; sub++) {
        items.push({ id: `L${n}:${row.index}${subs > 1 ? '.' + sub : ''}`, type: 'set', lift: n, set: row.index, sub, row, liftRef: lift });
      }
    }
  });
  if (day.assistance.length) {
    for (let r = 0; r < day.rounds.length; r++) items.push({ id: `A:${r}`, type: 'round', round: r });
  }
  return items;
}

/** What the sheet already says about an item (done before this session, or on another device). */
export function sheetEntry(item: Item, day: Day): Entry | null {
  if (item.type === 'round') return day.rounds[item.round] ? { status: 'done', at: '' } : null;
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

export function currentItem(items: Item[], session: Session, day: Day): Item | null {
  return items.find((it) => !entryFor(it, session, day)) ?? null;
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

function opId(): string {
  return crypto.randomUUID();
}

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
  };
}

export function roundOp(round: number, session: Session, done: boolean): Op {
  return {
    id: opId(), type: 'assist_round',
    cycle: session.cycle, week: session.week, day: session.day,
    index: round, done, sessionDate: session.date,
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
