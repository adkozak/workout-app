// Build the watch app for the Active 2 and show its install QR code as a proper
// square image in the browser (the terminal one is often stretched and won't scan).
//
//   node scripts/watch-qr.mjs        (npm run watch:update)
//
// Runs `zeus preview` with a hook that catches the URL it turns into a QR code,
// then writes watch/dist/install-qr.html and opens it. Scan it in Zepp:
// your watch's page → Developer mode → Scan.

import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DEVICE = 'Amazfit Active 2 (Round)';
const watchDir = new URL('../watch/', import.meta.url).pathname;
const urlFile = join(tmpdir(), `zeus-preview-url-${process.pid}`);
const hook = join(tmpdir(), `zeus-qr-hook-${process.pid}.cjs`);

// Loaded into zeus via NODE_OPTIONS: wraps qrcode-terminal's generate() to save its input.
writeFileSync(hook, `
const Module = require('module');
const load = Module._load;
Module._load = function (request, ...rest) {
  const m = load.call(this, request, ...rest);
  if (request === 'qrcode-terminal' && m && !m.__hooked) {
    const generate = m.generate.bind(m);
    m.generate = (input, ...args) => { require('fs').writeFileSync(${JSON.stringify(urlFile)}, String(input)); return generate(input, ...args); };
    m.__hooked = true;
  }
  return m;
};
`);

const run = spawnSync('npx', ['zeus', 'preview', '-t', DEVICE], {
  cwd: watchDir,
  stdio: 'inherit',
  env: { ...process.env, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --require ${hook}`.trim() },
});
rmSync(hook, { force: true });
if (run.status !== 0 || !existsSync(urlFile)) {
  console.error('\nNo QR code: zeus preview failed (logged in? try: cd watch && npx zeus login)');
  process.exit(1);
}
const url = readFileSync(urlFile, 'utf8');
rmSync(urlFile, { force: true });

// Same QR encoder zeus uses, drawn as an SVG with a quiet zone.
const require = createRequire(join(watchDir, 'package.json'));
const QRCode = require('qrcode-terminal/vendor/QRCode');
const L = require('qrcode-terminal/vendor/QRCode/QRErrorCorrectLevel').L;
const qr = new QRCode(-1, L);
qr.addData(url);
qr.make();
const n = qr.getModuleCount(), q = 4, size = n + 2 * q;
let rects = '';
for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) rects += `<rect x="${c + q}" y="${r + q}" width="1" height="1"/>`;
const expires = new Date(Date.now() + 7 * 86400e3).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
const html = `<!doctype html><meta charset="utf-8"><title>Workout 531: install on the watch</title>
<body style="margin:0;font-family:system-ui;text-align:center;background:#fff;color:#111">
<h2 style="margin:20px 0 4px">Workout 531 for ${DEVICE}</h2>
<p style="margin:0 0 12px;color:#555">Zepp → your watch → Developer mode → Scan. Valid until ${expires}.</p>
<svg viewBox="0 0 ${size} ${size}" width="420" height="420" shape-rendering="crispEdges" style="max-width:90vw;height:auto">
<rect width="${size}" height="${size}" fill="#fff"/><g fill="#000">${rects}</g></svg>
</body>`;
mkdirSync(join(watchDir, 'dist'), { recursive: true });
const out = join(watchDir, 'dist', 'install-qr.html');
writeFileSync(out, html);
console.log(`\nInstall QR saved: ${out}`);
const opened = spawnSync('xdg-open', [out], { stdio: 'ignore' });
if (opened.status !== 0) console.log('Open that file in a browser to scan it.');
