// Bundles the shared TypeScript logic for the two places that can't import it:
//   apps-script/live.js  live-session merging for the Apps Script backend (committed, pushed by clasp)
//   watch/lib/shared.js  session/plates/stats/live logic for the Zepp OS watch app (gitignored)
// Usage: node scripts/gen.mjs [apps-script|watch]   (no argument: both)

import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

export const targets = {
  'apps-script': {
    entryPoints: ['src/live.ts'],
    bundle: true,
    format: 'iife',
    globalName: 'Live',
    // Apps Script V8 handles modern syntax; es2019 keeps the output plain.
    target: 'es2019',
    outfile: 'apps-script/live.js',
    banner: { js: '// GENERATED from src/live.ts by `node scripts/gen.mjs`. Do not edit.' },
  },
  watch: {
    stdin: {
      contents: ['session', 'stats', 'plates', 'live', 'api'].map((m) => `export * from './src/${m}.ts';`).join('\n'),
      resolveDir: root,
      loader: 'ts',
    },
    bundle: true,
    format: 'esm',
    // The watch runs QuickJS; lowering ?. and ?? keeps the Zepp compiler happy on every firmware.
    target: 'es2019',
    outfile: 'watch/lib/shared.js',
    banner: { js: '// GENERATED from src/*.ts by `node scripts/gen.mjs`. Do not edit.' },
  },
};

export function buildTarget(name, write = true) {
  return build({ ...targets[name], absWorkingDir: root, write, logLevel: write ? 'warning' : 'silent' });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const which = process.argv[2] ? [process.argv[2]] : Object.keys(targets);
  for (const name of which) await buildTarget(name);
}
