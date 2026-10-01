// Phone and watch in one workout, through the fake backend over HTTP (with
// Apps Script's redirects): the phone's sync loop (src/liveSync.ts) and the
// watch's store, each doing what the user would do on that device.

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { handle } from '../lib/side.js';
import { clock, newStore, startBackend, zeppFetch } from './helpers.mjs';
import { sessionKey, touch } from '../../src/live.ts';
import { startLive } from '../../src/liveSync.ts';

const mem = new Map();
Object.assign(globalThis, {
  localStorage: {
    getItem: (k) => mem.get(k) ?? null,
    setItem: (k, v) => { mem.set(k, String(v)); },
    removeItem: (k) => { mem.delete(k); },
  },
  document: { visibilityState: 'visible', addEventListener() {}, removeEventListener() {} },
});

let be;
before(async () => { be = await startBackend(); });
after(() => be.close());

async function until(what, ok, ms = 8000) {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error(`timed out waiting for: ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

test('a workout started on the watch continues on the phone and back', async () => {
  const pkg = await handle('package', {}, { fetchFn: zeppFetch, cfg: be.cfg });
  const now = clock(Date.now() - 60e3);
  const watch = newStore(now);
  watch.setPackage(pkg);
  const syncWatch = async () => {
    const req = watch.syncRequest();
    return watch.applySync(req, await handle('sync', req, { fetchFn: zeppFetch, cfg: be.cfg }));
  };

  // Watch: start and log the first warm-up.
  const d = watch.suggestedDay();
  watch.start(d.week, d.day);
  now.advance(20);
  watch.done(watch.current());
  await syncWatch();

  // Phone: idle, picks the workout up on its own.
  let phone = null;
  const live = startLive(be.cfg, {
    getSession: () => phone,
    setSession: (s) => { phone = s; },
    setInventory: () => {},
    onDoc: () => {},
  });
  try {
    await until('phone joins', () => phone?.entries['L1:0']?.status === 'done');

    // Phone: log the second warm-up (as SessionView does: stamped change, then poke).
    const p = phone;
    phone = touch(p, { ...p, entries: { ...p.entries, 'L1:1': { status: 'done', at: new Date(now() + 30e3).toISOString() } }, cursor: 'L1:1' });
    live.poke();
    await until('phone pushes', () => !!be.backend.doGet({ token: 'dev', action: 'live' }).data.session.entries['L1:1']);

    now.advance(40);
    assert.equal((await syncWatch())?.type, 'merged');
    assert.equal(watch.current().id, 'L1:2', 'the watch moves on past the set done on the phone');

    // Phone: leave the workout; the watch drops it too.
    live.close(sessionKey(phone));
    phone = null;
    await until('close reaches the backend', () => be.backend.doGet({ token: 'dev', action: 'live' }).data.session === null);
    assert.equal((await syncWatch())?.type, 'closed-elsewhere');
    assert.equal(watch.session, null);
  } finally {
    live.stop();
  }
});
