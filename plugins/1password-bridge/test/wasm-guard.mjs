// Imports the module at process.argv[2] after making every WebAssembly entry
// point and every file-system read of a `.wasm` file report itself on stderr
// as a `WASM <what>` line. Prints `IMPORTED` on stderr once the import
// settles. Used by bundle.test.ts.

import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { pathToFileURL } from 'node:url';

const report = (what) => process.stderr.write(`WASM ${what}\n`);
const isWasm = (target) => String(target instanceof URL ? target.pathname : target).endsWith('.wasm');

function watchReads(target, names, label) {
  for (const name of names) {
    const original = target[name];
    target[name] = function (path, ...rest) {
      if (isWasm(path)) report(`${label}${name} ${String(path)}`);
      return original.call(this, path, ...rest);
    };
  }
}

watchReads(fs, ['readFileSync', 'readFile', 'openSync', 'open', 'createReadStream'], 'fs.');
watchReads(fs.promises, ['readFile', 'open'], 'fs.promises.');
syncBuiltinESMExports();

for (const name of ['compile', 'compileStreaming', 'instantiate', 'instantiateStreaming', 'validate']) {
  const original = WebAssembly[name];
  WebAssembly[name] = function (...args) {
    report(`WebAssembly.${name}`);
    return original.apply(this, args);
  };
}
const OriginalModule = WebAssembly.Module;
WebAssembly.Module = function (...args) {
  report('WebAssembly.Module');
  return new OriginalModule(...args);
};

await import(pathToFileURL(process.argv[2]).href);
process.stderr.write('IMPORTED\n');
