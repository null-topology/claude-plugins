// Stands in for a shutting-down server in the container removal tests.
// Usage: node docker-remove-runner.ts <name>...
// Starts the detached removal once, prints how long the call took as JSON,
// then lets the process end on its own: nothing calls process.exit, so a
// removal process that kept the event loop busy would keep this one alive.
import { removeContainersDetached } from '../../src/docker/remove.ts';

const names = process.argv.slice(2);
const started = performance.now();
removeContainersDetached(names);
const elapsedMs = performance.now() - started;
process.stdout.write(`${JSON.stringify({ elapsedMs })}\n`);
