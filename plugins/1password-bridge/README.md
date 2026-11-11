# 1password-bridge

Hands 1Password fields to Claude Code commands through one-use tickets, each use approved in a
window that shows the command, and masks secret values in Bash output.

## Why

A command that needs a token usually gets it pasted into the chat or read from a file, and from
then on the value sits in the transcript, in tool output and in whatever Claude writes next. This
plugin keeps the value out of the conversation. Claude asks for a ticket to a field by its
1Password reference and puts `"$(op-bridge redeem <ticket>)"` into the command that needs the
value. When the command runs, a window on your screen shows which session and agent ask, for which
field, why, and the command itself. Only after you approve does the value go to that command, once,
on the stdout of `op-bridge`. If a secret value of 8 or more characters shows up in a Bash
command's output anyway, in one of the forms listed under [Masking](#masking), it is replaced with
`<masked ticket=tkt_…>` before Claude sees it. The output of other tools is not masked.

The masking is a safety net against accidental exposure, not a barrier against an agent that tries
to get around it. See [Limits](#limits).

## What it does

### Tools

The MCP server `op` provides four tools; Claude Code names them
`mcp__plugin_1password-bridge_op__<tool>`. None of them opens the approval window or returns a
value; `fields` and `issue_tickets` may make the 1Password app ask for its authorization.

| Tool | What it does |
| --- | --- |
| `accounts` | Lists the 1Password accounts the plugin can address: the ones `op account list` reports when the op CLI is installed, plus the `accounts` setting. Marks the accounts the broker already holds an authorized connection to (warm). Never starts the broker. |
| `fields` | Lists an item's fields: titles, sections, types, whether a value is masked, and a reference for each, ready for `issue_tickets`. No values. |
| `issue_tickets` | Issues 1 to 5 tickets (`count`, default 1) for one field, with a `reason` of at most 500 characters for the window. Returns the ticket ids, their expiry and a preview of the field (type, masked or not). |
| `release` | Voids unused tickets and drops the masks of used ones (see [Masking](#masking) for its answers). A ticket whose value is on its way to a running command answers `in_flight`: it ends used or voided and no longer masks that command's output, though another ticket of the session may still mask the same value. |

References are `op://<vault>/<item>` for `fields` and
`op://<vault>/<item>/[<section>/]<field>[?attribute=otp|public-key|fingerprint|private-key]` for
`issue_tickets`, each segment a title or an id; `totp` is accepted as an alias of `otp`. `account` is optional when exactly one account is
known. It matches an account UUID, a sign-in URL (with or without `https://`), an email or a
configured entry, and must match exactly one account.

### A use

1. Claude calls `issue_tickets` with the field reference and a concrete reason. The broker looks
   the field up, reads it once to classify it, drops the value and creates the tickets in its
   memory. A ticket belongs to the agent that issued it (the main agent or one subagent), is valid
   for 10 minutes and serves one use.
2. Claude runs a command such as `TOKEN="$(op-bridge redeem tkt_…)" && curl -H "Authorization: Bearer $TOKEN" …`.
   `op-bridge` connects to the broker and names the ticket.
3. The broker checks that the ticket belongs to the calling session and finds the command through
   the session's list of running Bash commands, which the plugin's hooks keep. A ticket that
   another agent's running command names is refused at once. The redeem is attributed to the
   ticket's owner while the owner runs at least one command and no other agent of the session
   runs any. Until then (no command of the owner on the list, or another agent's command too) the
   broker reads the list again every 500 ms for up to 30 seconds.
4. The window shows the session title and id, the agent, the directory the session started in, the
   account, vault, item, section, field and type, the ticket id, the reason, and every running
   command of the owner with its directory, those that name the ticket first. On macOS a long
   command shows its first line and expands on request; zenity shows up to 40 lines of each.
5. Approve: the broker reads the field again; for a secret of 8 or more characters it lists the
   ticket in the session's `masked` marker and arms the mask, then sends the value. `op-bridge` prints it, with no
   newline, and confirms delivery. The ticket is used. Deny: the ticket is burned and `op-bridge`
   fails with `denied`.

A redeem that never got its answer (the command was interrupted, the window closed with the
command, no window could be shown) leaves the ticket unused while its 10 minutes last. One window
shows at a time; the next waits. There is no window timeout.

### op-bridge

`op-bridge redeem <ticket>` writes the value to stdout and nothing else. It never starts the
broker. Before it connects, it refuses with exit 2 when its stdout is closed or `/dev/null`: the
value would be lost while delivery is confirmed, so nothing is sent and the ticket stays unused.
Capture the value with `"$(op-bridge redeem <ticket>)"` instead. On failure it writes one line to
stderr, without the value, and exits with its own code:

| Exit | Code | Meaning |
| --- | --- | --- |
| 1 | other | no window backend, 1Password refused or timed out, an internal error |
| 1 | `untrusted` | the socket or its directory failed the owner and permission check; nothing was sent |
| 1 | `protocol` | the broker sent an answer op-bridge does not understand |
| 2 | `usage` | wrong arguments, or stdout is closed or `/dev/null`; nothing was sent |
| 10 | `denied` | you denied; the ticket is burned |
| 11 | `expired` | the ticket's 10 minutes passed |
| 12 | `busy` | the same ticket is already waiting for an answer, or its value is being sent |
| 13 | `not_owner` | another session or another agent holds the ticket, or `CLAUDE_CODE_SESSION_ID` is missing or not a session id (nothing was sent) |
| 14 | `other_agent` | attribution stayed unresolved for 30 seconds, and at the deadline another agent of the session had a command listed |
| 15 | `no_command` | attribution stayed unresolved for 30 seconds, and at the deadline no command of the ticket's owner was listed |
| 16 | `unknown` | no such ticket (never issued, its session ended, or the broker restarted) |
| 17 | `used` | already used or denied |
| 18 | `voided` | released, or its field is gone, or the session ended while its window was open or its value was fetched |
| 19 | `field_gone` | the field no longer resolves; the ticket is voided |
| 20 | `broker_down` | the broker's socket is not reachable; if the broker stopped, its tickets are gone |
| 21 | `not_delivered` | writing to stdout failed; the ticket is given back, and stays usable while its 10 minutes last and it was not released |
| 22 | `not_set_up` | the shell has no `OP_BRIDGE_STATE_DIR`: the SessionStart hook that ran for this session was an older version's, or none ran; nothing was sent and the ticket is unchanged (see [Update](#update)) |

### Masking

Secret types are masked: Concealed, CreditCardNumber, the SSH key's private key, the TOTP seed,
item notes and Unsupported. Every other value is plain, including the OTP code (`?attribute=otp`)
and the SSH `public-key` and `fingerprint`. Values shorter than 8 characters are delivered but not
masked; `issue_tickets` says so in its preview. The preview and the window go by the field at
issue; masking goes by the value fetched at approve.

At approve, before a secret of 8 or more characters leaves the broker, the broker adds the value to
the session's masks and lists the ticket id in the session's `masked` marker file (ids only). A mask covers the value
itself, its JSON-escaped and URL-encoded forms, its base64 forms (standard, unpadded, URL-safe and
wrapped at 76 columns, of the value and of the value plus a newline), and each trimmed line of 8 or
more characters of a multi-line value, except PEM armor lines.

Only Bash output is masked. While the marker exists, the PostToolUse hook sends the output of
every Bash call to the broker and Claude sees the masked output. Masking covers every string of
the output (`stdout`, `stderr`); keys, booleans and numbers stay, so the output keeps the Bash
output format. The output of every other tool (Read, Grep, MCP tools, Monitor and the rest) is not
masked, and neither is the output of a background Bash command, which Claude reads later through
another tool; see [Limits](#limits). If the broker cannot mask (it is not running, it no longer knows a
ticket's mask, or the marker cannot be read), the output is withheld: every string becomes a note,
which names the tickets to `release` when it can. Numbers, booleans, keys and the strings under
`type` and `mode` keys stay as they were. An output nested too deep to walk is replaced by the
note in the plain Bash output format (`stdout` and `stderr` both the note).

A failed command's output cannot be rewritten. For failed Bash commands the plugin installs an exit
trap: while the marker exists, a command that fails normally ends with a line `[exit N]` and exits
0, so the output goes through masking. Claude reads that line before treating a command as
successful. The trap runs only when the shell exits through it: a command that sets its own
`trap … EXIT`, replaces the shell with `exec`, or whose shell is killed by a signal fails as usual,
and its output reaches Claude unmasked. A child process killed by a signal
does not skip the trap: after a SIGKILLed child the output still ends with `[exit 137]`. Claude is told not to use an EXIT trap or `exec` in a command that
redeems a ticket. When a failed Bash command's output reaches the hooks unmasked, the broker
checks it: Claude is told which ticket's value it holds, or, when the
check cannot run or cannot name a ticket, that it may hold an unmasked value.

A mask lasts until the session ends or its ticket is released. One value delivered by several
tickets has one mask; it stays until all of them are released. `release` drops a ticket's mask and
answers `unmasked` when at least one value the ticket held is no longer masked by any ticket
(copies written earlier to files or logs then show it in plain text), or `mask_kept` when every
value it held stays masked under another ticket of the session. Tickets released in one call drop
their masks together, so two tickets of the same value released at once both answer `unmasked`
when no other ticket holds it.

### The broker

One broker process per user and protocol version serves every session. The MCP server starts it
when `fields`, `issue_tickets` or `release` finds none running; `accounts`, the hooks and
`op-bridge` never start it. It holds the 1Password connections, the tickets and the masks, all in
memory, and draws the windows. It makes one 1Password call at a time; a request still pending after
120 seconds, or still waiting that long behind a keep-alive call, fails with `auth_timeout` and the
broker exits, so the next request starts a new one. A keep-alive call still pending after 120
seconds is given up instead: the broker stays, with its masks, and forgets that account's
connection, so the next request for it connects again once the call has returned.
When `idle_window_minutes` have passed since the last `fields`, `issue_tickets` or redeem, it drops
its cached 1Password clients; the next 1Password operation reconnects and may make the 1Password
app ask for authorization again. It exits only when the idle window has passed, no client is
connected to the broker's socket, and no session holds a ticket that can still be used or a mask. It forgets a session's tickets and masks after 7 days without a
request for that session. A restart forgets every ticket: `redeem` answers `unknown` and Claude
issues new ones.

The socket is `<state dir>/run/broker-v2.sock` when that path is at most 100 bytes. When it is
longer, the socket moves to `$XDG_RUNTIME_DIR/1password-bridge/broker-v2.sock` (when
`XDG_RUNTIME_DIR` is set and absolute and that path is at most 100 bytes), else to
`<tmpdir>/1password-bridge-<uid>/broker-v2.sock`. That last path is not length-checked and may
exceed the platform's socket path limit. Before every connect, the MCP server, the hooks
and `op-bridge` check that the socket's directory is a real directory owned by you with no group
or other permission bits, and that the socket is a socket owned by you. When a check fails they
neither connect nor start a broker. On Windows, which has no uids, the check is skipped.

## Install

```sh
claude plugin marketplace add null-topology/claude-plugins
claude plugin install 1password-bridge@null-topology
```

Then restart Claude Code, so that the MCP server and the hooks start. An installed 0.1.0 is updated
in place (see [Update](#update)): the plugin id and data directory stay the same, SessionStart
removes 0.1.0's per-session `grants.json` and `env`, and a 0.1.0 broker, which listens on the v1
socket, never answers 0.2.0 and exits after its idle window.

### Requirements

- Node.js 22 or later, as `node` on `PATH`: the hooks, the MCP server and `op-bridge` run it.
- The 1Password 8 desktop app, signed in, with **Settings > Developer > Integrate with 1Password
  SDKs** turned on. On macOS the plugin looks for `libop_sdk_ipc_client.dylib` in
  `/Applications/1Password.app` or `~/Applications/1Password.app`. On Linux it looks for
  `libop_sdk_ipc_client.so` in `/usr/bin/1password`, `/opt/1Password` or `/snap/bin/1password`.
- The approval window: on macOS `/usr/bin/osascript`, which ships with the system; on Linux
  `zenity` on `PATH` and a display. Other platforms are not supported.
- Optional: the `op` CLI, so that `accounts` can list the accounts signed in to the app. Without it,
  set the `accounts` setting.

At session start the plugin checks for the app library and the window backend. It reports anything
missing both to you and to Claude. Without the window backend, tickets can still be issued (issuing
opens no window) but not redeemed; without the app, or on another platform, they can be neither
issued nor redeemed.

### Settings

Set them with `/plugin configure 1password-bridge@null-topology` and restart Claude Code.

| Setting | Default | Meaning |
| --- | --- | --- |
| `idle_window_minutes` | `60` | Minutes (5-720) after the last `fields`, `issue_tickets` or redeem until the broker drops its cached 1Password clients; the next 1Password operation reconnects and may make the app ask for authorization again. Tickets and masks are kept regardless. |
| `accounts` | empty | Comma-separated account names or UUIDs, for when the op CLI is not installed. An entry equal to an account UUID or sign-in host that `op` reports merges into that account. |
| `language` | `en` | Language of the approval window: `en` or `uk`. |

### Update

```sh
claude plugin marketplace update null-topology
claude plugin update 1password-bridge@null-topology
```

Then restart every running Claude Code session. A `/clear` alone in a session that was running
before the update may still run the old version's SessionStart hook, and its redeems fail with
`not_set_up`; `/reload-plugins` followed by `/clear` sets the session up as well.

## What it injects

- **MCP server `op`** with the four tools above and instructions for Claude: use a value only
  through `"$(op-bridge redeem <ticket>)"` inside the command that needs it; never echo, print,
  encode or write it; values are masked in Bash output only, so keep a value inside Bash commands
  and do not open a file that may hold one with another tool or print it in a background command;
  do not hand ticket ids to other
  agents (a subagent issues its own); read the
  `[exit N]` line before treating a command as successful; do not set an EXIT trap or use `exec`
  in a command that redeems a ticket; tell you when a warning says a value appeared unmasked.
- **Three lines in the session's `CLAUDE_ENV_FILE`**, which Claude Code sources before every Bash
  command: `OP_BRIDGE_STATE_DIR` (where the plugin keeps its state), `<plugin>/bin` prepended to
  `PATH` (for `op-bridge`), and the sourcing of `<plugin>/bin/exit-trap.sh`. No value is ever
  written there.
- **Hooks**, each a short `node` process. PreToolUse, PostToolUse and PostToolUseFailure run on
  every Bash call (PreToolUse also on the plugin's own tools), Stop and SubagentStop at every turn
  end; other tool calls run no hook. A hook with nothing to mask costs its startup, a few tens of
  milliseconds per Bash call; a masking call can wait for the broker for up to 8 seconds.
  - SessionStart: prepares the session's state directory, records the directory the session
    started in, appends the lines above, removes what 0.1.0 kept per session (`grants.json`,
    `env`), removes state of sessions not seen for 7 days and 1 hour (the broker forgets a
    session's tickets and masks after 7 days without a request for it), and reports missing
    dependencies.
  - PreToolUse on `^Bash$`: adds the command to the session's list of running commands (command
    text, directory, agent; no values). The command itself is never rewritten. PreToolUse on
    `fields`, `issue_tickets` and `release`: puts the live session id, transcript path, agent id
    and type and working directory into the call, over anything Claude passed.
  - PostToolUse on `^Bash$`: removes a finished command from the list (a background command
    stays listed until a Stop or SubagentStop no longer reports its task) and masks the output
    while the session holds a mask.
  - PostToolUseFailure on `^Bash$`: removes a failed command from the list and, while the
    session holds a mask, warns when the failed output may hold an unmasked value.
  - Both ignore any other tool, whatever the matcher lets through.
  - Stop and SubagentStop: remove what the agent left on the list, and background commands whose
    task has ended.
  - SessionEnd: tells the broker to forget the session's tickets and masks and removes its state.

No hook ever prints a value, and every hook exits 0. Every hook run but SessionEnd marks the
session as seen. When a hook cannot act, it logs a code to `log/hook.log`, never a value.

State lives under `CLAUDE_PLUGIN_DATA` (else `$XDG_STATE_HOME/1password-bridge`, else
`~/.local/state/1password-bridge`): per session the list of running commands, the `masked`
marker, a `last-seen` file and `session.json`; the hooks' log at `log/hook.log` and the broker's at
`log/broker.log`; the broker's socket under `run/`, or, when that path is too long for a socket,
under `$XDG_RUNTIME_DIR/1password-bridge/` or `<tmp>/1password-bridge-<uid>/`. None of these hold
a value.

## Limits

- **Not a barrier against the agent.** An agent that wants a value can print it in a way the masks
  do not recognise, or write it to a file. The plugin stops accidents, not intent.
- **Attribution is by elimination.** The broker cannot see which process called `op-bridge`. It
  attributes a redeem to the ticket's owner only while no other agent of the session runs a
  command. A process the hooks do not track (a detached process, a Monitor command) can redeem
  while the owner alone runs commands; the window then shows the owner's commands.
- **Concurrent agents wait.** While another agent of the session runs a command, or the ticket's
  owner runs none, a redeem waits up to 30 seconds and may fail with `other_agent` or
  `no_command`.
- **Masking covers Bash output only.** The output of every other tool (Read, Grep, MCP tools,
  Monitor and the rest) is not masked: use a value only inside Bash commands, do not open a file
  that may hold a value with another tool, and do not watch a command whose output can contain a
  value. A Bash command that runs in the background (`run_in_background`, or moved there by the
  Bash timeout) returns no output of its own; Claude reads its output later through another tool,
  so it is not masked: do not print a value in such a command. A value written to a file, a log or
  another program's output is not masked there.
  Releasing a ticket shows earlier copies in plain text the next time they are read. Telemetry
  taken outside the masking hook, such as an OpenTelemetry export, may receive the output unmasked.
- **Other encodings are not recognised.** A value printed in any form other than those listed under
  [Masking](#masking), such as hex, a hash, or part of a larger base64 blob, is not masked.
- **Short values are not masked.** A value shorter than 8 characters is delivered unmasked. The
  window's note goes by the field at issue: a value changed in 1Password to a shorter one before
  approve is delivered unmasked although the window said masked.
- **Failed commands report success** while the session holds a mask, normally with `[exit N]` as
  the last line. A command that sets its own `trap … EXIT`, uses `exec`, or whose shell is killed
  by a signal skips the exit trap: it fails as usual and its output is not
  masked. A command that redirects its
  own stdout (`exec >/dev/null`) also hides the `[exit N]` line.
- **Withheld output keeps its format.** When masking fails, every string becomes a note; numbers,
  booleans, keys and `type` and `mode` strings stay, and an output too deep to walk becomes the
  note in the plain Bash output format.
- **Tickets live in the broker.** A broker restart forgets them, and a mask the broker forgot
  makes the output withheld until the tickets are released.
- **Allow rules.** Claude Code cannot match a command that contains `"$(op-bridge redeem …)"`
  against prefix allow rules, so such a command may need your permission approval in default mode,
  besides the redeem window.
- **The socket path is computed twice.** `op-bridge` computes it from the Bash command's
  environment, the broker from the MCP server's. When `<state dir>/run/broker-v2.sock` is longer
  than 100 bytes, the path falls back to `XDG_RUNTIME_DIR` or the temporary directory, and the
  temporary directory's path is not length-checked. When the two computed socket paths differ,
  every redeem fails with `broker_down`.
- **The broker's socket is yours.** While the broker runs, any process running as you can call
  `fields` on its socket and read item metadata (titles, types, no values). A redeem still needs
  a running command on the session's list and your approval in the window.
- **Auto mode.** The auto mode classifier does not know about the approval window, and its default
  Credential Exploration rule may block `fields`, `issue_tickets` or a redeem command. To allow
  them, add the four MCP tools (`mcp__plugin_1password-bridge_op__accounts`, `…__fields`,
  `…__issue_tickets`, `…__release`) to `permissions.allow`, and add to `autoMode.allow` an entry
  that names this plugin's use as a Credential Exploration false positive, keeping `"$defaults"`
  first in that list. Keep the entry to credentials the user asked for and to redeems visible on
  the command line (a `$(op-bridge redeem …)` substitution, or a ticket id passed to a script): a
  lookup on the agent's own initiative stays Credential Exploration. `claude auto-mode critique`
  reviews such a rule.
- **Windows** exist on macOS (JXA) and on Linux with zenity only.
- **Other sessions.** A process of another session that reads this session's transcript is out of
  scope.

## Layout

```text
.claude-plugin/plugin.json   manifest and settings
.mcp.json                    the MCP server `op`
hooks/hooks.json             hook registrations
skills/using-secrets/        agent skill: writing redeem commands, reading failures, release
bin/op-bridge                shell shim running dist/cli.js
bin/exit-trap.sh             EXIT trap sourced by every Bash command
dialog/macos-window.js       the macOS approval window (JXA)
dist/                        committed bundles: server.js, hook.js, cli.js, broker.js
src/mcp/                     MCP server and tools, account discovery, broker client
src/broker/                  broker: tickets, attribution, masks, window, 1Password access
src/hooks/                   hook handlers and the SessionStart dependency check
src/cli/                     op-bridge
src/mask/                    needle generation and masking
src/store/title.ts           session titles from the transcript
src/board.ts                 the list of running commands
src/session-files.ts         marker, last-seen and session.json
src/sdk-core-stub.ts         stands in for the SDK's WebAssembly core: the broker uses desktop authentication only
src/*.ts                     protocol, references, classification, paths, lifetimes, window strings, version
scripts/build.mjs            esbuild bundling
test/                        node:test suites
```

## Development

Development needs Node.js 22.18 or later, because the tests run the TypeScript sources directly.

```sh
npm ci
npm run typecheck
npm test
npm run build        # rebuilds the bundles in dist/
npm run check:dist   # rebuilds dist/ and fails on unstaged differences in dist/
```

The bundles in `dist/` are committed. Rebuild them and commit them with every source change.

## License

MIT
