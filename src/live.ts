// Live sync of the workout in progress between the phone app and the watch.
// Each device keeps its own copy of the session and the backend keeps a third
// (the "live doc"); every sync merges them. Merging is per piece: each set
// entry carries the time it was logged, extras are a set with tombstones, and
// the few other fields (lift order, paused groups, ...) carry the time they
// were last changed. So the latest action wins wherever it was made, and two
// devices never overwrite each other's sets.
//
// Bundled as-is into the Apps Script backend (apps-script/live.js, generated)
// and the watch app, so it must stay free of DOM and Node APIs.

import type { Entry, Extra, Session } from './session.ts';

/** Session fields that aren't per-set: last change wins, by `session.stamps[field]`. */
export const SCALAR_FIELDS = ['liftOrder', 'cursor', 'paused', 'roundCount', 'rpe', 'finishedAt', 'hr'] as const;
type ScalarField = (typeof SCALAR_FIELDS)[number];

export interface LiveDoc {
  /** Bumped on every change, so a client can tell nothing happened. */
  v: number;
  session: Session | null;
  /** The last workout that was closed (saved or left), so other devices drop it too. */
  closed?: { key: string; at: string };
  /** Plates free today (pairs per plate size), shared so both devices plan the same loadings. */
  inventory?: { value: Record<number, number>; at: string };
  /** Latest heart rate from the watch, for the phone's session header. */
  hr?: { bpm: number; at: string };
  at?: string;
}

/** What a device sends: its session, and/or that it closed one. */
export interface LivePush {
  session?: Session | null;
  close?: string;
  inventory?: LiveDoc['inventory'];
  hr?: LiveDoc['hr'];
}

export const EMPTY_LIVE: LiveDoc = { v: 0, session: null };

/** One workout: the same day of the same cycle, on the same date. */
export function sessionKey(s: Pick<Session, 'cycle' | 'week' | 'day' | 'date'>): string {
  return `${s.cycle}/w${s.week}d${s.day}/${s.date}`;
}

/** JSON with sorted keys (undefined dropped), so "did anything change" ignores key order. */
export function canon(x: unknown): string {
  if (x === null || typeof x !== 'object') return JSON.stringify(x) ?? 'null';
  if (Array.isArray(x)) return `[${x.map(canon).join(',')}]`;
  const o = x as Record<string, unknown>;
  return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canon(o[k])}`).join(',')}}`;
}

const same = (a: unknown, b: unknown) => canon(a) === canon(b);

/** Stamps the fields that changed since `prev`, so a merge knows these values are the newest. */
export function touch(prev: Session | null, next: Session, now = new Date().toISOString()): Session {
  if (!prev || sessionKey(prev) !== sessionKey(next)) return next;
  let stamps = next.stamps;
  for (const f of SCALAR_FIELDS) {
    if (!same(prev[f], next[f])) stamps = { ...stamps, [f]: now };
  }
  return stamps === next.stamps ? next : { ...next, stamps };
}

/** Two copies of the same workout, combined. */
export function mergeSessions(a: Session, b: Session): Session {
  const entries: Record<string, Entry> = { ...a.entries };
  for (const id of Object.keys(b.entries)) {
    const theirs = b.entries[id], mine = entries[id];
    if (!mine || theirs.at > mine.at) entries[id] = theirs;
  }
  const out: Session = { ...a, entries, startedAt: b.startedAt && b.startedAt < a.startedAt ? b.startedAt : a.startedAt };

  const removed = [...new Set([...(a.removedExtras ?? []), ...(b.removedExtras ?? [])])];
  const extras = new Map<string, Extra>();
  for (const x of [...(a.extras ?? []), ...(b.extras ?? [])]) {
    if (!removed.includes(x.id) && !extras.has(x.id)) extras.set(x.id, x);
  }
  if (a.extras || b.extras) out.extras = [...extras.values()].sort((x, y) => (x.at < y.at ? -1 : x.at > y.at ? 1 : 0));
  if (removed.length) out.removedExtras = removed;

  const stamps: Partial<Record<ScalarField, string>> = { ...a.stamps };
  for (const f of SCALAR_FIELDS) {
    const sa = a.stamps?.[f], sb = b.stamps?.[f];
    // Unstamped values (set when the session was created) lose to any stamped change.
    const takeB = sb ? !sa || sb > sa : !sa && a[f] === undefined && b[f] !== undefined;
    if (!takeB) continue;
    if (b[f] === undefined) delete out[f];
    else (out as unknown as Record<string, unknown>)[f] = b[f];
    if (sb) stamps[f] = sb;
  }
  if (Object.keys(stamps).length) out.stamps = stamps;
  return out;
}

/** A copy of a workout that was closed after it started: something to drop, not to resurrect. */
export function isClosed(s: Session, closed: LiveDoc['closed']): boolean {
  return !!closed && closed.key === sessionKey(s) && s.startedAt <= closed.at;
}

/** Two sessions that may be different workouts: same workout merges, otherwise the newer start wins. */
function combine(mine: Session, theirs: Session): Session {
  if (sessionKey(mine) === sessionKey(theirs)) return mergeSessions(mine, theirs);
  return theirs.startedAt > mine.startedAt ? theirs : mine;
}

/** Server side: fold a device's push into the live doc. */
export function applyPush(doc: LiveDoc, push: LivePush, now = new Date().toISOString()): LiveDoc {
  const next: LiveDoc = { ...doc };
  if (push.close) {
    if (next.session && sessionKey(next.session) === push.close) next.session = null;
    next.closed = { key: push.close, at: now };
  }
  if (push.session && !isClosed(push.session, next.closed)) {
    next.session = next.session ? combine(next.session, push.session) : push.session;
  }
  if (push.inventory && (!next.inventory || push.inventory.at > next.inventory.at)) next.inventory = push.inventory;
  if (push.hr && (!next.hr || push.hr.at > next.hr.at)) next.hr = push.hr;

  const strip = ({ v: _v, at: _at, ...rest }: LiveDoc) => rest;
  if (same(strip(next), strip(doc))) return doc;
  return { ...next, v: doc.v + 1, at: now };
}

/**
 * Device side: what the local session becomes after hearing from the server.
 * A workout started on the other device is picked up, but only if it is today's.
 */
export function reconcile(local: Session | null, doc: LiveDoc, today: string): Session | null {
  const remote = doc.session && !isClosed(doc.session, doc.closed) ? doc.session : null;
  if (local && isClosed(local, doc.closed)) local = null;
  if (!local) return remote && remote.date === today ? remote : null;
  return remote ? combine(local, remote) : local;
}
