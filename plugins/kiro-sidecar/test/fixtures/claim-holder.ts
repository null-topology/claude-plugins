// A second server process that waits on turn 1 of a run and so holds its claim.
// Usage: node claim-holder.ts <stateDir> <launchId> <owner> <home> <timeoutS>
// The wait polls once per timeout, so it looks for the result only at the
// start and at its deadline; it prints the wait's result as one JSON line and
// exits.
import { TurnClaims } from '../../src/session/claims.ts';
import { waitTurn } from '../../src/session/queries.ts';

const [stateDir, launchId, owner, home, timeoutS] = process.argv.slice(2);
if (stateDir === undefined || launchId === undefined || owner === undefined || home === undefined || timeoutS === undefined) {
  throw new Error('usage: claim-holder.ts <stateDir> <launchId> <owner> <home> <timeoutS>');
}

const timeout = Number(timeoutS);
const claims = new TurnClaims(stateDir);
try {
  const result = await waitTurn(
    {
      stateDir,
      home,
      owner,
      live: { get: () => undefined, list: () => [] },
      claim: (id, turn) => claims.claim(id, turn),
      pollMs: timeout * 1000,
    },
    { session: launchId, turn: 1, timeout_s: timeout },
  );
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  process.stdout.write(`${JSON.stringify({ error: String(error) })}\n`);
}
