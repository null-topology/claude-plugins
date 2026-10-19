import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { killProcessGroups } from './acp/process.ts';
import { createServer } from './mcp-server.ts';

/** The exit path never takes longer than this, whatever is still running. */
const EXIT_DEADLINE_MS = 490;

// Stdout carries the MCP protocol only; diagnostics go to stderr.
const { server, runtime } = createServer();

let exiting = false;

/** Ends every session once, then exits 0: on SIGINT, SIGTERM, SIGHUP and the end of stdin. */
function exit(): void {
  if (exiting) {
    return;
  }
  exiting = true;
  setTimeout(() => process.exit(0), EXIT_DEADLINE_MS).unref();
  runtime
    .shutdown()
    .catch((error: unknown) => runtime.log(`shutdown: ${String(error)}`))
    .finally(() => process.exit(0));
}

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
  process.on(signal, exit);
}
process.stdin.on('end', exit);
process.stdin.on('close', exit);
// Whatever ends the process, no local Kiro process outlives it.
process.on('exit', killProcessGroups);

await server.connect(new StdioServerTransport());
