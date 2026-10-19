// Bundles each entry point in src/ into a self-contained ESM file in dist/.
// dist/ is committed so the installed plugin needs no `npm install`; the output
// must be deterministic (`npm run check:dist` fails on any drift).
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

// One entry per executable the plugin runs; dist/<name>.js mirrors src/<name>.ts.
const ENTRY_POINTS = ['src/server.ts', 'src/waiter.ts', 'src/context.ts', 'src/sidecar-tools.ts'];

await build({
  absWorkingDir: ROOT,
  entryPoints: ENTRY_POINTS,
  outbase: 'src',
  outdir: 'dist',
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  charset: 'utf8',
  logLevel: 'warning',
});
