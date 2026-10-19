// Rewrites one JSON file many times with writeJsonAtomic, for the reader test.
// Usage: node json-writer.ts <path> <versions> <payload bytes>
import { writeJsonAtomic } from '../../src/store/files.ts';

const [path, versions, payloadBytes] = process.argv.slice(2);
if (path === undefined || versions === undefined || payloadBytes === undefined) {
  throw new Error('usage: json-writer.ts <path> <versions> <payload bytes>');
}
const count = Number(versions);
const size = Number(payloadBytes);
for (let version = 1; version <= count; version += 1) {
  const fill = String.fromCharCode(97 + (version % 26));
  await writeJsonAtomic(path, { version, payload: fill.repeat(size) });
}
