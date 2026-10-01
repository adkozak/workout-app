// Offline write queue. Every action becomes an op with a unique id, stored on
// the phone first and sent to the sheet whenever there is signal. The backend
// ignores ids it has already applied, so retries are safe.

import type { Config } from './api.ts';
import type { Op } from './session.ts';

const QUEUE_KEY = 'queue';
const FAILED_KEY = 'failed';

export interface SyncState { pending: number; failed: number; lastError: string | null; flushing: boolean }

type Listener = (s: SyncState) => void;
const listeners = new Set<Listener>();
let flushing = false;
let lastError: string | null = null;

function read(key: string): Op[] {
  return JSON.parse(localStorage.getItem(key) ?? '[]') as Op[];
}

function write(key: string, ops: Op[]): void {
  localStorage.setItem(key, JSON.stringify(ops));
}

export function syncState(): SyncState {
  return { pending: read(QUEUE_KEY).length, failed: read(FAILED_KEY).length, lastError, flushing };
}

function notify(): void {
  const s = syncState();
  listeners.forEach((l) => l(s));
}

export function onSync(l: Listener): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function enqueue(cfg: Config, ...ops: Op[]): void {
  write(QUEUE_KEY, [...read(QUEUE_KEY), ...ops]);
  notify();
  void flush(cfg);
}

export async function flush(cfg: Config): Promise<void> {
  if (flushing) return;
  const ops = read(QUEUE_KEY);
  if (ops.length === 0) return;
  flushing = true;
  notify();
  try {
    const res = await fetch(cfg.url, {
      method: 'POST',
      // text/plain keeps this a "simple" request: Apps Script can't answer CORS preflights.
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ token: cfg.token, ops }),
    });
    const body = (await res.json()) as { ok: boolean; error?: string; data?: { results: { id: string; status: string; error?: string }[] } };
    if (!body.ok || !body.data) throw new Error(body.error ?? `HTTP ${res.status}`);
    const done = new Set<string>();
    const failed: Op[] = [];
    for (const r of body.data.results) {
      done.add(r.id);
      if (r.status === 'error') {
        const op = ops.find((o) => o.id === r.id);
        if (op) failed.push({ ...op, error: r.error });
      }
    }
    // Keep anything enqueued while this request was in flight.
    write(QUEUE_KEY, read(QUEUE_KEY).filter((o) => !done.has(o.id)));
    if (failed.length) write(FAILED_KEY, [...read(FAILED_KEY), ...failed]);
    lastError = failed.length ? `${failed[0].error}` : null;
  } catch (e) {
    lastError = (e as Error).message;
  } finally {
    flushing = false;
    notify();
  }
  if (read(QUEUE_KEY).length && !lastError) void flush(cfg);
}

/**
 * Sends ops right now and reports how each went, for actions the user waits on
 * (creating a cycle). Nothing is queued: offline, it just fails.
 */
export async function sendNow(cfg: Config, ops: Op[]): Promise<{ id: string; status: string; error?: string }[]> {
  const res = await fetch(cfg.url, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ token: cfg.token, ops }),
  });
  const body = (await res.json()) as { ok: boolean; error?: string; data?: { results: { id: string; status: string; error?: string }[] } };
  if (!body.ok || !body.data) throw new Error(body.error ?? `HTTP ${res.status}`);
  return body.data.results;
}

/** Retry on reconnect and every 20 s while anything is pending. */
export function startSync(cfg: Config): () => void {
  const tick = () => { if (read(QUEUE_KEY).length) void flush(cfg); };
  window.addEventListener('online', tick);
  const t = setInterval(tick, 20000);
  tick();
  return () => { window.removeEventListener('online', tick); clearInterval(t); };
}
