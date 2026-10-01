// Local test backend: the real apps-script code on a throwaway copy of the sheet.
//
//   npm run devserver                   # fixture data (or the last saved state)
//   npm run devserver -- --snapshot     # start from devserver/data/snapshot.json (your real data, see xlsx2json.py)
//   npm run devserver -- --reset        # throw away saved state and reseed
//
// Serves /exec like an Apps Script web app, including its habit of answering
// with a 302 to a second URL (turn off with --no-redirect). Every write is saved
// to devserver/data/state.json. Open http://localhost:8787/ for setup links and
// a view of the sheet tabs.

import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { parseArgs } from 'node:util';
import { createBackend } from './gas.mjs';
import { fixture } from './fixture.mjs';
import { handleExec, send } from './http.mjs';

const { values: args } = parseArgs({
  options: {
    port: { type: 'string', default: '8787' },
    token: { type: 'string', default: 'dev' },
    snapshot: { type: 'boolean', default: false },
    reset: { type: 'boolean', default: false },
    'no-redirect': { type: 'boolean', default: false },
    'pwa-port': { type: 'string', default: '5173' },
  },
});

const DATA_DIR = new URL('./data/', import.meta.url);
const STATE = new URL('state.json', DATA_DIR);
const SNAPSHOT = new URL('snapshot.json', DATA_DIR);
mkdirSync(DATA_DIR, { recursive: true });

function seed() {
  if (args.snapshot) {
    if (!existsSync(SNAPSHOT)) throw new Error('no devserver/data/snapshot.json; see devserver/xlsx2json.py');
    console.log('seeding from snapshot.json');
    return JSON.parse(readFileSync(SNAPSHOT, 'utf8'));
  }
  console.log('seeding from the synthetic fixture');
  return fixture();
}

const initial = !args.reset && existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : seed();
let backend = createBackend(initial, { token: args.token });
const save = () => writeFileSync(STATE, JSON.stringify(backend.toJSON()));
save();

const lanIp = () => Object.values(networkInterfaces()).flat()
  .find((i) => i && i.family === 'IPv4' && !i.internal)?.address ?? 'localhost';

const setupCode = (host) => Buffer.from(JSON.stringify({
  url: `http://${host}:${args.port}/exec`, token: args.token, name: 'dev server',
})).toString('base64url');

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

function cellText(v) {
  if (Object.prototype.toString.call(v) === '[object Date]') return v.toISOString().replace('T', ' ').slice(0, 16);
  if (v === true) return '☑';
  if (v === false) return '☐';
  return v;
}

function sheetHtml(name, range) {
  const sheet = backend.ss.getSheetByName(name);
  if (!sheet) return `<p>No tab ${esc(name)}</p>`;
  const rows = range
    ? sheet.getRange(range).getValues()
    : sheet.getRange(Math.max(1, sheet.getLastRow() - 199), 1, Math.min(200, Math.max(1, sheet.getLastRow())), Math.max(1, sheet.getLastColumn())).getValues();
  return `<table>${rows.map((r) => `<tr>${r.map((v) => `<td>${esc(cellText(v))}</td>`).join('')}</tr>`).join('')}</table>`;
}

function indexHtml() {
  const ip = lanIp();
  const live = backend.doGet({ token: args.token, action: 'live' }).data;
  const tabs = backend.ss.getSheets().map((s) => s.getName());
  return `<!doctype html><meta charset="utf-8"><title>workout dev server</title>
<style>body{font:14px system-ui;margin:2em;max-width:60em}code,textarea{font:12px monospace}td{border:1px solid #ddd;padding:2px 6px;white-space:nowrap}table{border-collapse:collapse}</style>
<h1>Workout dev server</h1>
<p>Test copy of the sheet; nothing here reaches Google. Token <code>${esc(args.token)}</code>.</p>
<h2>Setup</h2>
<ul>
<li>PWA (run <code>npm run dev -- --host</code>): <a href="http://${ip}:${args['pwa-port']}/#setup=${setupCode(ip)}">http://${ip}:${args['pwa-port']}/#setup=…</a>
 or on this machine <a href="http://localhost:${args['pwa-port']}/#setup=${setupCode('localhost')}">localhost</a></li>
<li>Watch (Zepp app → the app's settings → paste): <textarea rows=2 cols=80 readonly>${setupCode(ip)}</textarea>
 <br><small>Simulator: <code>${setupCode('localhost')}</code></small></li>
</ul>
<h2>Live session (v${live.v})</h2>
<pre>${esc(JSON.stringify(live, null, 1).slice(0, 3000))}</pre>
<form method="post" action="/reset"><button>Reset data</button> (reseeds from ${args.snapshot ? 'snapshot' : 'fixture'})</form>
<h2>Tabs</h2>
<p>${tabs.map((t) => `<a href="/sheet?name=${encodeURIComponent(t)}">${esc(t)}</a>`).join(' · ')}</p>`;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    const handled = await handleExec(req, res, {
      backend: () => backend,
      redirect: !args['no-redirect'],
      onPost: (out) => {
        save();
        const ops = out.ok ? out.data.results : [];
        if (ops.length) console.log(new Date().toISOString().slice(11, 19), 'ops:', ops.map((o) => `${o.status}${o.error ? ` (${o.error})` : ''}`).join(', '));
      },
    });
    if (handled) return;
    if (url.pathname === '/reset' && req.method === 'POST') {
      backend = createBackend(seed(), { token: args.token });
      save();
      return send(res, 303, '', 'text/html', { Location: '/' });
    }
    if (url.pathname === '/sheet') {
      const name = url.searchParams.get('name') ?? '';
      return send(res, 200, `<!doctype html><meta charset="utf-8"><style>td{border:1px solid #ddd;padding:2px 6px;font:12px system-ui;white-space:nowrap}table{border-collapse:collapse}</style><p><a href="/">←</a> ${esc(name)} (last 200 rows; ?range=A1:K40 for a range)</p>${sheetHtml(name, url.searchParams.get('range'))}`, 'text/html; charset=utf-8');
    }
    if (url.pathname === '/') return send(res, 200, indexHtml(), 'text/html; charset=utf-8');
    send(res, 404, JSON.stringify({ ok: false, error: 'not found' }));
  } catch (err) {
    send(res, 500, JSON.stringify({ ok: false, error: String(err.stack ?? err) }));
  }
});

server.listen(Number(args.port), '0.0.0.0', () => {
  console.log(`dev backend on http://localhost:${args.port}/  (LAN: http://${lanIp()}:${args.port}/exec, token "${args.token}")`);
});
