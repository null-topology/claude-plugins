// Bundles each executable in src/ into a self-contained ESM file in dist/.
// dist/ is committed so the installed plugin needs no `npm install`; the output
// must be deterministic (`npm run check:dist` fails on any drift).
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

const COMMON = {
  absWorkingDir: ROOT,
  outdir: 'dist',
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  charset: 'utf8',
  logLevel: 'warning',
};

// The MCP server, the hooks and the CLI; none loads the 1Password SDK.
await build({
  ...COMMON,
  entryPoints: [
    { in: 'src/mcp/main.ts', out: 'server' },
    { in: 'src/hooks/main.ts', out: 'hook' },
    { in: 'src/cli/main.ts', out: 'cli' },
  ],
});

// The broker, the only bundle with the 1Password SDK. Desktop authentication never
// calls the SDK's wasm core, so `@1password/sdk-core` is replaced by a stub instead
// of shipping the wasm file. The SDK is CommonJS and calls `require`, which an ESM
// bundle lacks; the banner defines it.
await build({
  ...COMMON,
  entryPoints: [{ in: 'src/broker/main.ts', out: 'broker' }],
  alias: { '@1password/sdk-core': './src/sdk-core-stub.ts' },
  banner: {
    js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
  },
});
