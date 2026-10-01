// Test rig: the fake backend behind a real HTTP server (with Apps Script's
// redirects), a Zepp-like fetch that does not follow redirects, and a watch
// store with in-memory storage and a controllable clock.

import { createServer } from 'node:http';
import { createBackend } from '../../devserver/gas.mjs';
import { fixture } from '../../devserver/fixture.mjs';
import { handleExec } from '../../devserver/http.mjs';
import { Store } from '../lib/store.js';

// Real time minus a bit: the backend stamps closes with its own clock, like Apps Script does.
export const TODAY = new Date(Date.now() - 2 * 3600e3);

export async function startBackend() {
  const backend = createBackend(fixture(TODAY), { token: 'dev' });
  const server = createServer((req, res) => { void handleExec(req, res, { backend: () => backend }); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/exec`;
  return { backend, url, cfg: { url, token: 'dev' }, close: () => new Promise((r) => server.close(r)) };
}

/** Like Zepp's side-service fetch: {url, method, headers, body} -> {status, headers, body: string}. */
export async function zeppFetch({ url, method = 'GET', headers, body }) {
  const res = await fetch(url, { method, headers, body, redirect: 'manual' });
  return { status: res.status, headers: Object.fromEntries(res.headers), body: await res.text() };
}

export function memoryStorage() {
  const m = new Map();
  return {
    get: (k) => (m.has(k) ? JSON.parse(m.get(k)) : undefined),
    set: (k, v) => { if (v === undefined) m.delete(k); else m.set(k, JSON.stringify(v)); },
  };
}

export function clock(start = TODAY.getTime()) {
  let t = start;
  const now = () => t;
  now.advance = (secs) => { t += secs * 1000; };
  return now;
}

export function newStore(now = clock()) {
  return new Store(memoryStorage(), now);
}
