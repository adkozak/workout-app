// Keeps this phone's copy of the workout in step with the watch, through the
// live doc on the backend (see live.ts): pushes what changed here, merges in
// what changed there, and passes on the watch's heart rate and plate choices.

import type { Config } from './api.ts';
import { canon, reconcile, type LiveDoc, type LivePush } from './live.ts';
import { localDate, type Session } from './session.ts';
import type { Inventory } from './plates.ts';

const SERVER_KEY = 'liveServer';
const CLOSE_KEY = 'liveClose';
const INVENTORY_AT_KEY = 'inventoryAt';

export interface LiveHooks {
  getSession: () => Session | null;
  /** Replace the session with the merged one; must not stamp it as a local change. */
  setSession: (s: Session | null) => void;
  setInventory: (inv: Inventory) => void;
  onDoc: (doc: LiveDoc) => void;
}

export interface LiveSync {
  stop: () => void;
  /** This device closed the workout (saved or left): tell the watch. */
  close: (key: string) => void;
  inventoryChanged: (inv: Inventory) => void;
  /** Sync now instead of at the next tick. */
  poke: () => void;
}

async function call(cfg: Config, push: LivePush | null): Promise<LiveDoc> {
  const res = push
    ? await fetch(cfg.url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ token: cfg.token, ops: [], live: push }),
    })
    : await fetch(`${cfg.url}?action=live&token=${encodeURIComponent(cfg.token)}`);
  const body = (await res.json()) as { ok: boolean; error?: string; data?: LiveDoc | { live: LiveDoc } };
  if (!body.ok || !body.data) throw new Error(body.error ?? `HTTP ${res.status}`);
  return push ? (body.data as { live: LiveDoc }).live : (body.data as LiveDoc);
}

export function startLive(cfg: Config, hooks: LiveHooks): LiveSync {
  let busy = false;
  let pendingInventory: { value: Inventory; at: string } | null = null;

  const tick = async () => {
    if (busy || document.visibilityState !== 'visible') return;
    busy = true;
    try {
      const s = hooks.getSession();
      const push: LivePush = {};
      // A practice workout stays on this phone.
      if (s && !s.practice && canon(s) !== localStorage.getItem(SERVER_KEY)) push.session = s;
      const closing = localStorage.getItem(CLOSE_KEY);
      if (closing) push.close = closing;
      if (pendingInventory) push.inventory = pendingInventory;
      const sent = Object.keys(push).length ? push : null;
      const doc = await call(cfg, sent);

      localStorage.setItem(SERVER_KEY, doc.session ? canon(doc.session) : '');
      if (closing && doc.closed?.key === closing) localStorage.removeItem(CLOSE_KEY);
      if (sent?.inventory === pendingInventory) pendingInventory = null;
      if (doc.inventory && doc.inventory.at > (localStorage.getItem(INVENTORY_AT_KEY) ?? '')) {
        localStorage.setItem(INVENTORY_AT_KEY, doc.inventory.at);
        hooks.setInventory(doc.inventory.value);
      }
      // The session may have changed while the request was out; merge into the current one.
      const cur = hooks.getSession();
      const next = cur?.practice ? cur : localStorage.getItem(CLOSE_KEY) ? null : reconcile(cur, doc, localDate());
      if (canon(next) !== canon(cur)) hooks.setSession(next);
      hooks.onDoc(doc);
    } catch {
      // Offline or backend hiccup: the next tick tries again; sets are safe in the op queue.
    } finally {
      busy = false;
    }
  };

  let last = 0;
  const loop = setInterval(() => {
    const every = hooks.getSession() ? 5000 : 20000;
    if (Date.now() - last >= every) { last = Date.now(); void tick(); }
  }, 1000);
  const onVisible = () => { if (document.visibilityState === 'visible') { last = Date.now(); void tick(); } };
  document.addEventListener('visibilitychange', onVisible);
  void tick();

  return {
    stop: () => { clearInterval(loop); document.removeEventListener('visibilitychange', onVisible); },
    close: (key) => { localStorage.setItem(CLOSE_KEY, key); last = 0; },
    inventoryChanged: (value) => {
      const at = new Date().toISOString();
      localStorage.setItem(INVENTORY_AT_KEY, at);
      pendingInventory = { value, at };
      last = 0;
    },
    poke: () => { last = 0; },
  };
}
