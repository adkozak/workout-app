// GENERATED from src/live.ts by `node scripts/gen.mjs`. Do not edit.
"use strict";
var Live = (() => {
  var __defProp = Object.defineProperty;
  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __export = (target, all) => {
    for (var name in all)
      __defProp(target, name, { get: all[name], enumerable: true });
  };
  var __copyProps = (to, from, except, desc) => {
    if (from && typeof from === "object" || typeof from === "function") {
      for (let key of __getOwnPropNames(from))
        if (!__hasOwnProp.call(to, key) && key !== except)
          __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
    }
    return to;
  };
  var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

  // src/live.ts
  var live_exports = {};
  __export(live_exports, {
    EMPTY_LIVE: () => EMPTY_LIVE,
    SCALAR_FIELDS: () => SCALAR_FIELDS,
    applyPush: () => applyPush,
    canon: () => canon,
    isClosed: () => isClosed,
    mergeSessions: () => mergeSessions,
    reconcile: () => reconcile,
    sessionKey: () => sessionKey,
    touch: () => touch
  });
  var SCALAR_FIELDS = ["liftOrder", "cursor", "paused", "roundCount", "rpe", "finishedAt", "hr"];
  var EMPTY_LIVE = { v: 0, session: null };
  function sessionKey(s) {
    return `${s.cycle}/w${s.week}d${s.day}/${s.date}`;
  }
  function canon(x) {
    var _a;
    if (x === null || typeof x !== "object") return (_a = JSON.stringify(x)) != null ? _a : "null";
    if (Array.isArray(x)) return `[${x.map(canon).join(",")}]`;
    const o = x;
    return `{${Object.keys(o).filter((k) => o[k] !== void 0).sort().map((k) => `${JSON.stringify(k)}:${canon(o[k])}`).join(",")}}`;
  }
  var same = (a, b) => canon(a) === canon(b);
  function touch(prev, next, now = (/* @__PURE__ */ new Date()).toISOString()) {
    if (!prev || sessionKey(prev) !== sessionKey(next)) return next;
    let stamps = next.stamps;
    for (const f of SCALAR_FIELDS) {
      if (!same(prev[f], next[f])) stamps = { ...stamps, [f]: now };
    }
    return stamps === next.stamps ? next : { ...next, stamps };
  }
  function mergeSessions(a, b) {
    var _a, _b, _c, _d, _e, _f;
    const entries = { ...a.entries };
    for (const id of Object.keys(b.entries)) {
      const theirs = b.entries[id], mine = entries[id];
      if (!mine || theirs.at > mine.at) entries[id] = theirs;
    }
    const out = { ...a, entries, startedAt: b.startedAt && b.startedAt < a.startedAt ? b.startedAt : a.startedAt };
    const removed = [.../* @__PURE__ */ new Set([...(_a = a.removedExtras) != null ? _a : [], ...(_b = b.removedExtras) != null ? _b : []])];
    const extras = /* @__PURE__ */ new Map();
    for (const x of [...(_c = a.extras) != null ? _c : [], ...(_d = b.extras) != null ? _d : []]) {
      if (!removed.includes(x.id) && !extras.has(x.id)) extras.set(x.id, x);
    }
    if (a.extras || b.extras) out.extras = [...extras.values()].sort((x, y) => x.at < y.at ? -1 : x.at > y.at ? 1 : 0);
    if (removed.length) out.removedExtras = removed;
    const stamps = { ...a.stamps };
    for (const f of SCALAR_FIELDS) {
      const sa = (_e = a.stamps) == null ? void 0 : _e[f], sb = (_f = b.stamps) == null ? void 0 : _f[f];
      const takeB = sb ? !sa || sb > sa : !sa && a[f] === void 0 && b[f] !== void 0;
      if (!takeB) continue;
      if (b[f] === void 0) delete out[f];
      else out[f] = b[f];
      if (sb) stamps[f] = sb;
    }
    if (Object.keys(stamps).length) out.stamps = stamps;
    return out;
  }
  function isClosed(s, closed) {
    return !!closed && closed.key === sessionKey(s) && s.startedAt <= closed.at;
  }
  function combine(mine, theirs) {
    if (sessionKey(mine) === sessionKey(theirs)) return mergeSessions(mine, theirs);
    return theirs.startedAt > mine.startedAt ? theirs : mine;
  }
  function applyPush(doc, push, now = (/* @__PURE__ */ new Date()).toISOString()) {
    const next = { ...doc };
    if (push.close) {
      if (next.session && sessionKey(next.session) === push.close) next.session = null;
      next.closed = { key: push.close, at: now };
    }
    if (push.session && !isClosed(push.session, next.closed)) {
      next.session = next.session ? combine(next.session, push.session) : push.session;
    }
    if (push.inventory && (!next.inventory || push.inventory.at > next.inventory.at)) next.inventory = push.inventory;
    if (push.hr && (!next.hr || push.hr.at > next.hr.at)) next.hr = push.hr;
    const strip = ({ v: _v, at: _at, ...rest }) => rest;
    if (same(strip(next), strip(doc))) return doc;
    return { ...next, v: doc.v + 1, at: now };
  }
  function reconcile(local, doc, today) {
    const remote = doc.session && !isClosed(doc.session, doc.closed) ? doc.session : null;
    if (local && isClosed(local, doc.closed)) local = null;
    if (!local) return remote && remote.date === today ? remote : null;
    return remote ? combine(local, remote) : local;
  }
  return __toCommonJS(live_exports);
})();
