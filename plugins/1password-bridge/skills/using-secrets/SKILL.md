---
name: using-secrets
description: Use when a command needs a secret kept in 1Password (an API token, a password, a key, a one-time code), when the user asks to use or pass such a credential or to write one into a file, and whenever Bash output shows an "op-bridge:" error, an "[exit N]" last line, a "<masked ticket=…>" label or a "[1password-bridge: …]" note. Covers fields, issue_tickets, "$(op-bridge redeem …)", reading failures, release, and when the next step is the user's.
---

# Using 1Password secrets in commands

The plugin's server instructions give the rules. This skill adds how to write the command, how to
read what comes back, and which answers belong to the user.

## Get a ticket

- You need the vault and the item. No tool searches 1Password: use what the user named, and ask
  when they named nothing or the name is ambiguous. `fields` with `op://<vault>/<item>` lists the
  fields with ready refs; `accounts` helps when more than one account exists.
- Pass the ref from `fields` to `issue_tickets`. For a current one-time code add `?attribute=otp`:
  the bare ref of a one-time password field is its seed.
- The reason is what the user reads in the window before approving, so name the command and its
  purpose: "curl to api.github.com: list open PRs of acme/widgets", not "need token". With
  `count` above 1 the same reason shows in every window, so make it cover each planned command; at
  most 500 characters.
- One ticket serves one Bash call: the shell keeps no variables between calls. Set `count` to the
  calls you plan within the next 10 minutes (at most 5). An unused ticket opens no window.
- The answer previews masking from the field at issue; masking follows the value fetched at
  approve. A value marked NOT masked shows in plain text wherever it is printed.
- Tickets belong to the agent that issued them. A subagent that needs a secret issues its own:
  give it the ref (`op://…`), never a ticket id.

## Write the command

Capture the value in a plain assignment and chain the rest with `&&`:

```bash
TOKEN="$(op-bridge redeem tkt_…)" && curl -fsS -H "Authorization: Bearer $TOKEN" https://api.example.com/…
PW="$(op-bridge redeem tkt_…)" && PGPASSWORD="$PW" psql -h db.internal -U app -c 'select 1'
```

- Only a plain assignment carries the redeem's exit status. `export X="$(…)"`, `local X="$(…)"`,
  a prefix assignment `X="$(…)" cmd` and an inline `"…$(op-bridge redeem …)…"` argument run the
  command, or the next one, with an empty value when the redeem fails. Export afterwards when a
  child process needs it: `X="$(…)" && export X && ./deploy.sh`.
- Redeem once per command and reuse the variable.
- Give the Bash call a long `timeout`, such as 600000: the command waits while the user reads the
  window, and a command the timeout moves to the background has its output read later, unmasked.
- Never use `run_in_background` for a command that redeems: its output is read later through
  another tool and is not masked. Keep `trap … EXIT` and `exec` out of it: they skip the plugin's
  exit trap, so a failed command keeps its status and its output is not masked.
- A command that runs on (a dev server, a watcher, a tunnel) does not fit: the Bash call reaches
  its timeout, the process goes on in the background with its later output unmasked, and while it
  is listed every other agent's redeem fails with `other_agent`. Say so before starting one with a
  value, and offer that the user starts it in their own terminal.
- Redeem while no other agent of this session has a command running, background ones included:
  until they end, a redeem waits 30 s and fails with `other_agent`.
- Do not print the value, not even to check it: test it (`[ -n "$TOKEN" ]`) or read the answer of
  the command that used it. Do not write it to a file, a log or a message, and do not open a file
  that may hold it with Read or Grep: only Bash output is masked.
- Do not get the value any other way (`op read`, `op run`, the 1Password app). The window is how
  the user controls each use.

## Read the result

- `<masked ticket=tkt_…>` stands for a delivered value or an encoding of it; the id is the earliest
  unreleased ticket that holds the value. That is expected; do not try to recover it.
- A last line `[exit N]` means the command failed with status N although the tool reported
  success. It appears from the approval of the session's first masked value until all its masked
  tickets are released; a short or non-secret value does not start it. Handle it as the failure
  it is.
- A failed redeem writes `op-bridge: <code>: <message>` to stderr (bad arguments:
  `usage: op-bridge redeem <ticket>`), and the exit status is the code's:

| Code (exit) | Next step |
| --- | --- |
| `denied` (10) | The user refused this use and the ticket is burned. Do not retry, issue a new ticket or get the value another way; ask the user how to go on. |
| `expired` (11), `unknown` (16), `voided` (18) | The ticket is gone. Issue a new one if the work still needs the value. |
| `used` (17) | Used, or denied earlier. If a deny cannot be ruled out, ask the user before issuing another ticket; otherwise issue a new one. |
| `busy` (12) | Another command is redeeming this ticket now: its window is open or its value is on its way. Do not redeem it again meanwhile. If that command ends without the value, the ticket is usable again; if it got the value, issue a new one. |
| `other_agent` (14) | At the 30 s deadline another agent of this session had a command listed, background ones included. The ticket is still usable: rerun when that agent's commands have ended; if one runs on (a server, a watcher), tell the user. |
| `no_command` (15) | At the deadline no command of yours was listed. The ticket is still usable: rerun as a normal foreground Bash call; if it repeats, tell the user the plugin's hooks may be off. |
| `not_owner` (13) | If the message says `CLAUDE_CODE_SESSION_ID` is not set or is not a session id, the setup is broken: tell the user. Otherwise another agent or session holds the ticket: issue your own. |
| `field_gone` (19) | The field no longer resolves. Run `fields` again, and ask the user if it moved. |
| `broker_down` (20) | The broker is not reachable and its tickets may be gone. Issue a new ticket once; if it repeats, tell the user. |
| `not_delivered` (21) | Writing stdout failed. The ticket stays usable while its 10 minutes last and it is not released: rerun with the value captured in `"$(…)"`; a new window opens. |
| `not_set_up` (22) | This shell lacks the plugin's session setup: an older version's SessionStart hook ran for this session. Nothing was sent and the ticket is unchanged. Do not retry: tell the user to run `/reload-plugins` and then `/clear`, or to restart the session. |
| `usage` (2) | Bad arguments (check the ticket id), or stdout is closed or `/dev/null`: capture the value in `"$(…)"`. The ticket is unchanged. |
| other (1) | Read the message. A missing window backend, a 1Password refusal or an untrusted socket is the user's to fix: tell them. |

- `fields` and `issue_tickets` refuse with `<code>: <message>`:
  - `not_found`, `ambiguous` (the message lists ids to use), `bad_ref`, `invalid_arguments` and
    `account` are yours to fix from the message; ask the user when the item or the account
    remains unclear.
  - `auth_denied`, `auth_timeout`, `integration_off`, `no_app`, `no_session` (the plugin's hooks
    did not run), `internal` and `broker_…` are the user's: tell them what the message says
    instead of calling again.

## Plugin notes in the output

- `[1password-bridge: output withheld, masking failed; call release with …]`: this call's output
  could not be masked. The command did run, so check its outcome before repeating anything with
  side effects. The cause may pass (a hook timeout, a very large output), or the broker may have
  lost those masks. Do not release on your own: releasing lifts masks the broker may still hold,
  and the values then show in plain text. Tell the user; if Bash output keeps coming back
  withheld, the masks are gone, and the user decides whether to release the named tickets.
- `[1password-bridge: output withheld, the masking marker of this session cannot be read …]`:
  there is nothing to release. Tell the user.
- A warning that failed output contains, or may contain, an unmasked value: do not repeat it, and
  tell the user, who may need to rotate it.

## Release

- When the work is done, release the tickets you never redeemed, so nothing stays redeemable. A
  ticket whose redeem was approved but not delivered may hold a mask: releasing it drops that mask
  although the answer says only `voided`. Releasing a ticket whose command still waits at the
  window closes that window and fails that redeem.
- Release a used ticket only when its mask gets in your way. The value then shows in plain text in
  later output and wherever it was written before (`unmasked`); `mask_kept` means another ticket
  still masks it.

## When the next step is the user's

- The vault, item or account is unknown or ambiguous.
- A redeem was `denied`, or a `used` ticket may have been denied.
- The user asks you to write a value into a file, a config, a log or a message. Say that a value
  written to a file is not masked and stays there in plain text, so the plugin's rules keep values
  out of files; offer to pass it through the environment of the command that needs it, and leave
  the choice to them. They can write the file themselves.
- An error points at the setup: hooks, the window, 1Password authorization, the socket.
- The auto mode classifier denies a plugin tool or a redeem command (Credential Exploration, for
  example). Do not look for another way to the value; tell the user, who can add an exception
  (the plugin's README, Limits).
- Bash output keeps coming back withheld.
- A warning says a value appeared unmasked.
