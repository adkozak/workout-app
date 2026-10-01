// The side service's work, without Zepp APIs so it can be tested in Node:
// reading the setup code, talking to the Apps Script backend, and shrinking
// the bootstrap into a package small enough to send over Bluetooth.

import { sameWeekIn } from './shared.js';

export { b64decode, parseSetup } from './setup.js';

function header(headers, name) {
  if (!headers) return undefined;
  for (const k of Object.keys(headers)) if (k.toLowerCase() === name) return headers[k];
  return undefined;
}

function resolve(base, loc) {
  if (/^https?:\/\//.test(loc)) return loc;
  const origin = /^(https?:\/\/[^/]+)/.exec(base)[1];
  return loc.startsWith('/') ? origin + loc : `${base.replace(/[^/]*$/, '')}${loc}`;
}

/**
 * Calls the backend with Zepp's side-service fetch ({url, method, headers, body} ->
 * {status, headers, body}). Apps Script answers with a 302 to the real output;
 * if fetch doesn't follow it, we do (as a GET, like browsers do after a POST).
 */
export async function callApi(fetchFn, { url, method = 'GET', body }, hops = 0) {
  const res = await fetchFn({
    url, method,
    headers: method === 'POST' ? { 'Content-Type': 'text/plain;charset=utf-8' } : {},
    ...(body !== undefined ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}),
  });
  const status = res.status;
  if (status >= 300 && status < 400 && hops < 4) {
    const loc = header(res.headers, 'location');
    if (!loc) throw new Error(`HTTP ${status} without a location`);
    return callApi(fetchFn, { url: resolve(url, loc), method: 'GET' }, hops + 1);
  }
  let data = res.body;
  if (typeof data === 'string') {
    try { data = JSON.parse(data); } catch (e) {
      throw new Error(status >= 400 ? `HTTP ${status}` : 'backend did not answer with JSON (is the web app deployed for "Anyone"?)');
    }
  }
  if (!data || !data.ok) throw new Error((data && data.error) || `HTTP ${status}`);
  return data.data;
}

const q = (cfg, action) => `${cfg.url}${cfg.url.includes('?') ? '&' : '?'}action=${action}&token=${encodeURIComponent(cfg.token)}`;

/** Bootstrap without what the watch doesn't use (cell refs, notes, the session log). */
export function makePackage(b, now = new Date()) {
  const trimSet = (s) => {
    const o = { index: s.index, kind: s.kind, pct: s.pct, weight: s.weight, sets: s.sets, reps: s.reps };
    if (s.done !== undefined) o.done = s.done;
    if (s.actual !== undefined) o.actual = s.actual;
    return o;
  };
  const c = b.cycle;
  const cycle = {
    name: c.name, number: c.number, tm: c.tm, writable: c.writable, layoutProblems: c.layoutProblems.slice(0, 1),
    bodyweight: c.bodyweight,
    weeks: c.weeks.map((w) => ({
      week: w.week,
      days: w.days.map((d) => ({
        day: d.day,
        lifts: d.lifts.map((l) => ({ name: l.name, key: l.key, sets: l.sets.map(trimSet) })),
        assistance: d.assistance, rounds: d.rounds, assistanceNote: d.assistanceNote,
      })),
    })),
  };
  const keys = [...new Set(c.weeks.flatMap((w) => w.days.flatMap((d) => d.lifts.map((l) => l.key).filter(Boolean))))];
  const amraps = {}, lastCycle = {};
  for (const key of keys) {
    amraps[key] = b.history.sessions.filter((s) => s.lifts[key]).map((s) => [s.date, s.lifts[key].weight, s.lifts[key].reps])
      .sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0));
    lastCycle[key] = {};
    for (const week of [1, 2, 3]) {
      const x = sameWeekIn(b.previous, week, key);
      if (x) lastCycle[key][week] = x;
    }
  }
  return { at: now.toISOString(), cycle, amraps, lastCycle };
}

/** Handles a request from the watch. `cfg` is the parsed setup (or null). */
export async function handle(method, params, { fetchFn, cfg }) {
  if (method === 'status') return { configured: !!cfg, name: cfg ? cfg.name || null : null };
  if (!cfg) throw new Error('not set up: paste the setup code in the Zepp app settings');
  if (method === 'package') {
    return makePackage(await callApi(fetchFn, { url: q(cfg, 'bootstrap') }));
  }
  if (method === 'sync') {
    const ops = (params && params.ops) || [];
    const push = params && params.push;
    if (!ops.length && !push) return { results: [], live: await callApi(fetchFn, { url: q(cfg, 'live') }) };
    return callApi(fetchFn, { url: cfg.url, method: 'POST', body: { token: cfg.token, ops, live: push || undefined } });
  }
  throw new Error(`unknown method ${method}`);
}
