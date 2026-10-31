import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  cappedLines,
  commandPreview,
  pangoEscape,
  platformDialog,
  runCommand,
  ticketApproval,
  type Approval,
  type RunResult,
  type Runner,
  type TicketApprovalDetails,
} from '../../src/broker/dialog.ts';

const ROOT = '/plugin/root';

const APPROVAL: Approval = {
  title: 'Claude Code requests a secret',
  reason: 'deploy the staging site',
  rows: [
    ['Session ID', 'session-0000-test', true],
    ['Vault', 'Deploy'],
  ],
  commands: [],
  labels: { command: 'Command', literal: 'Command naming this ticket', expand: 'Show all' },
  approve: 'Approve',
  deny: 'Deny',
};

interface Call {
  command: string;
  args: string[];
  timeoutMs: number | undefined;
  signal?: AbortSignal | undefined;
}

function fakeRunner(results: (RunResult | ((signal?: AbortSignal) => Promise<RunResult>))[]): Runner & { calls: Call[] } {
  const calls: Call[] = [];
  const run: Runner = async (command, args, timeoutMs, signal) => {
    calls.push({ command, args, timeoutMs, signal });
    const next = results.shift();
    if (next === undefined) throw new Error('unexpected run');
    return typeof next === 'function' ? next(signal) : next;
  };
  return Object.assign(run, { calls });
}

/** A window that stays open until its process is killed through the signal. */
function untilKilled(signal?: AbortSignal): Promise<RunResult> {
  return new Promise((resolve) => signal?.addEventListener('abort', () => resolve({ kind: 'error' }), { once: true }));
}

const tick = () => new Promise((resolve) => setImmediate(resolve));
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('macOS window', () => {
  test('runs the JXA window with the approval as JSON and no timeout', async () => {
    const run = fakeRunner([{ kind: 'exit', code: 0, stdout: 'approve\n' }]);
    assert.equal(await platformDialog(run, 'darwin', ROOT).ask(APPROVAL), 'approve');
    assert.equal(run.calls.length, 1);
    const call = run.calls[0] as Call;
    assert.equal(call.command, 'osascript');
    assert.deepEqual(call.args.slice(0, 3), ['-l', 'JavaScript', join(ROOT, 'dialog', 'macos-window.js')]);
    assert.equal(call.args.length, 4);
    assert.deepEqual(JSON.parse(call.args[3] as string), APPROVAL);
    assert.equal(call.timeoutMs, undefined);
  });

  test('maps deny and every failure', async () => {
    const cases: [RunResult, string][] = [
      [{ kind: 'exit', code: 0, stdout: 'deny\n' }, 'deny'],
      [{ kind: 'timeout' }, 'unavailable'],
      [{ kind: 'exit', code: 1, stdout: '' }, 'unavailable'],
      [{ kind: 'exit', code: 0, stdout: 'something else' }, 'unavailable'],
      [{ kind: 'missing' }, 'unavailable'],
      [{ kind: 'error' }, 'unavailable'],
    ];
    for (const [result, answer] of cases) {
      assert.equal(await platformDialog(fakeRunner([result]), 'darwin', ROOT).ask(APPROVAL), answer, JSON.stringify(result));
    }
  });

  test('the window script reads the modal code as a number: JXA returns it as a string', () => {
    // JXA cannot run in CI, so this reads the script itself.
    const source = readFileSync(new URL('../../dialog/macos-window.js', import.meta.url), 'utf8');
    assert.match(source, /Number\(code\) === APPROVE/);
    assert.doesNotMatch(source, /\bcode === APPROVE/);
  });
});

describe('Linux zenity', () => {
  test('runs zenity --question with escaped rows, labels and width', async () => {
    const run = fakeRunner([{ kind: 'exit', code: 0, stdout: '' }]);
    assert.equal(await platformDialog(run, 'linux', ROOT).ask(APPROVAL), 'approve');
    const call = run.calls[0] as Call;
    assert.equal(call.command, 'zenity');
    assert.deepEqual(call.args, [
      '--question',
      '--title=Claude Code requests a secret',
      '--text=<b>Session ID</b>  <tt>session-0000-test</tt>\n<b>Vault</b>  Deploy\n\ndeploy the staging site',
      '--ok-label=Approve',
      '--cancel-label=Deny',
      '--width=520',
    ]);
    assert.equal(call.timeoutMs, undefined, 'the window has no timeout');
  });

  test('escapes markup and backslashes in every text', async () => {
    const run = fakeRunner([{ kind: 'exit', code: 1, stdout: '' }]);
    // The command goes through ticketApproval, as in the broker, so its U+202E is already a visible escape here.
    const { commands } = ticketApproval(
      {
        session: { id: 'session-0000-test' },
        agent: { id: 'main' },
        account: 'Work',
        vault: 'Deploy',
        item: 'Deploy server',
        category: 'Login',
        field: 'api token',
        fieldType: 'Concealed',
        kind: { masked: true, short: false },
        ticket: 'tkt_abcdefghijklmnop',
        reason: 'deploy',
        commands: [{ command: 'echo \u{202E}hs.txt', cwd: '/work/<site>', literal: false }],
      },
      'en',
    );
    const tricky: Approval = { ...APPROVAL, reason: 'a <b>bold</b> & "quoted" \\n it\'s', rows: [['Item', 'x<y>&z\\t', true]], commands };
    await platformDialog(run, 'linux', ROOT).ask(tricky);
    const text = (run.calls[0] as Call).args[2] as string;
    assert.equal(
      text,
      '--text=<b>Item</b>  <tt>x&lt;y&gt;&amp;z\\\\t</tt>\n\na &lt;b&gt;bold&lt;/b&gt; &amp; &quot;quoted&quot; \\\\n it&#39;s' +
        '\n\n<b>Command</b>  /work/&lt;site&gt;\n<tt>echo \\\\u{202E}hs.txt</tt>',
    );
    assert.equal(pangoEscape(`<>&"'`), '&lt;&gt;&amp;&quot;&#39;');
  });

  test('exit 1 is a deny; any other end is no answer, so it cannot burn the ticket', async () => {
    // zenity exits 1 for the deny button, Escape and closing the window; a process killed by a signal is `error`.
    const cases: [RunResult, string][] = [
      [{ kind: 'exit', code: 1, stdout: '' }, 'deny'],
      [{ kind: 'exit', code: 5, stdout: '' }, 'unavailable'],
      [{ kind: 'exit', code: 255, stdout: '' }, 'unavailable'],
      [{ kind: 'timeout' }, 'unavailable'],
      [{ kind: 'missing' }, 'unavailable'],
      [{ kind: 'error' }, 'unavailable'],
    ];
    for (const [result, answer] of cases) {
      assert.equal(await platformDialog(fakeRunner([result]), 'linux', ROOT).ask(APPROVAL), answer, JSON.stringify(result));
    }
  });
});

describe('other platforms', () => {
  test('have no window and run nothing', async () => {
    const run = fakeRunner([]);
    assert.equal(await platformDialog(run, 'win32', ROOT).ask(APPROVAL), 'unavailable');
    assert.equal(await platformDialog(run, 'freebsd', ROOT).ask(APPROVAL), 'unavailable');
    assert.equal(run.calls.length, 0);
  });
});

describe('queue', () => {
  test('shows one window at a time, in the order asked', async () => {
    const releases: (() => void)[] = [];
    const held = (answer: string) => () =>
      new Promise<RunResult>((resolve) => releases.push(() => resolve({ kind: 'exit', code: 0, stdout: answer })));
    const run = fakeRunner([held('approve'), held('deny'), held('approve')]);
    const dialog = platformDialog(run, 'darwin', ROOT);
    const answers: string[] = [];
    const asks = ['first', 'second', 'third'].map((reason) =>
      dialog.ask({ ...APPROVAL, reason }).then((a) => answers.push(`${reason}:${a}`)),
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(run.calls.length, 1, 'the second window waits for the first');
    releases.shift()?.();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(run.calls.length, 2);
    releases.shift()?.();
    await new Promise((resolve) => setImmediate(resolve));
    releases.shift()?.();
    await Promise.all(asks);
    assert.deepEqual(answers, ['first:approve', 'second:deny', 'third:approve']);
    assert.deepEqual(
      run.calls.map((c) => (JSON.parse(c.args[3] as string) as Approval).reason),
      ['first', 'second', 'third'],
    );
  });

  test('a failed window does not block the next one', async () => {
    const run = fakeRunner([() => Promise.reject(new Error('boom')), { kind: 'exit', code: 0, stdout: 'approve' }]);
    const dialog = platformDialog(run, 'darwin', ROOT);
    const [first, second] = await Promise.all([dialog.ask(APPROVAL), dialog.ask(APPROVAL)]);
    assert.equal(first, 'unavailable');
    assert.equal(second, 'approve');
  });
});

describe('close', () => {
  for (const platform of ['darwin', 'linux'] as const) {
    test(`${platform}: kills the open window and answers it and every queued one unavailable`, { timeout: 5000 }, async () => {
      const run = fakeRunner([untilKilled, { kind: 'exit', code: 0, stdout: 'approve' }]);
      const dialog = platformDialog(run, platform, ROOT);
      const open = dialog.ask(APPROVAL);
      const queued = dialog.ask({ ...APPROVAL, reason: 'queued' });
      await tick();
      assert.equal(run.calls.length, 1);
      dialog.close();
      assert.equal(run.calls[0]?.signal?.aborted, true, 'the open window process is killed');
      assert.deepEqual(await Promise.all([open, queued]), ['unavailable', 'unavailable']);
      assert.equal(run.calls.length, 1, 'the queued window never starts');
    });
  }

  test('answers unavailable to an open and a queued ask that carry their own signals', { timeout: 5000 }, async () => {
    const run = fakeRunner([untilKilled, { kind: 'exit', code: 0, stdout: 'approve' }]);
    const dialog = platformDialog(run, 'darwin', ROOT);
    const open = dialog.ask(APPROVAL, new AbortController().signal);
    const queued = dialog.ask({ ...APPROVAL, reason: 'queued' }, new AbortController().signal);
    await tick();
    assert.equal(run.calls.length, 1);
    dialog.close();
    assert.equal(run.calls[0]?.signal?.aborted, true, 'the open window process is killed');
    assert.deepEqual(await Promise.all([open, queued]), ['unavailable', 'unavailable']);
    assert.equal(run.calls.length, 1, 'the queued window never starts');
  });

  test('an ask after close starts no process', async () => {
    const run = fakeRunner([]);
    const dialog = platformDialog(run, 'darwin', ROOT);
    dialog.close();
    dialog.close();
    assert.equal(await dialog.ask(APPROVAL), 'unavailable');
    assert.equal(run.calls.length, 0);
  });
});

describe('ticketApproval', () => {
  const details: TicketApprovalDetails = {
    session: { id: 'session-0000-test', title: 'Deploy staging', startDir: '/work/site' },
    agent: { id: 'main' },
    account: 'Work',
    vault: 'Deploy',
    item: 'Deploy server',
    category: 'Login',
    section: 'add more',
    field: 'api token',
    fieldType: 'Concealed',
    kind: { masked: true, short: false },
    ticket: 'tkt_abcdefghijklmnop',
    reason: 'deploy the staging site',
    commands: [
      { command: './deploy.sh', cwd: '/work/site', literal: false },
      { command: 'T="$(op-bridge redeem tkt_abcdefghijklmnop)" && curl', cwd: '/work/site', literal: true },
    ],
  };

  test('lists the rows in order, in English by default, without a variable row', () => {
    const a = ticketApproval(details, undefined);
    assert.deepEqual(a.rows, [
      ['Session', 'Deploy staging'],
      ['Session ID', 'session-0000-test', true],
      ['Agent', 'main'],
      ['Started in', '/work/site', true],
      ['Account', 'Work'],
      ['Vault', 'Deploy'],
      ['Item', 'Deploy server · Login'],
      ['Section', 'add more'],
      ['Field', 'api token'],
      ['Type', 'Concealed · secret, masked in Bash output'],
      ['Ticket', 'tkt_abcdefghijklmnop', true],
    ]);
    assert.equal(a.reason, 'deploy the staging site');
    assert.deepEqual(a.commands[0], { short: './deploy.sh', full: './deploy.sh', cwd: '/work/site', literal: false });
    assert.deepEqual(a.labels, { command: 'Command', literal: 'Command naming this ticket', expand: 'Show all' });
  });

  test('a subagent is shown with its type; missing title, start directory and section are left out', () => {
    const a = ticketApproval(
      { ...details, session: { id: 'session-0000-test' }, agent: { id: 'agent-1', type: 'general-purpose' }, section: undefined },
      'en',
    );
    assert.deepEqual(
      a.rows.map((r) => r[0]),
      ['Session ID', 'Agent', 'Account', 'Vault', 'Item', 'Field', 'Type', 'Ticket'],
    );
    assert.deepEqual(a.rows[1], ['Agent', 'subagent · general-purpose']);
  });

  test('a subagent without a type is shown with its id', () => {
    const a = ticketApproval({ ...details, agent: { id: 'agent-7' } }, 'en');
    assert.deepEqual(a.rows[2], ['Agent', 'subagent · agent-7']);
  });

  test('keeps several commands in their order, each with its own directory and literal flag', () => {
    const commands = [
      { command: 'cd /work/site', cwd: '/work', literal: false },
      { command: 'T="$(op-bridge redeem tkt_abcdefghijklmnop)" && curl', cwd: '/work/site', literal: true },
      { command: 'make deploy', cwd: '/work/site/build', literal: false },
    ];
    const a = ticketApproval({ ...details, commands }, 'en');
    assert.deepEqual(
      a.commands.map((c) => [c.full, c.cwd, c.literal]),
      commands.map((c) => [c.command, c.cwd, c.literal]),
    );
  });

  test('a reason cannot draw lines: line breaks and tabs become one space, other hidden characters escapes', () => {
    const reason = 'deploy\nCommand naming this ticket\r\nrm -rf /\u{2028}x\u{2029}y\rz\tw\u{202E}evil\u{200B}';
    const a = ticketApproval({ ...details, reason }, 'en');
    assert.equal(a.reason, 'deploy Command naming this ticket rm -rf / x y z w\\u{202E}evil\\u{200B}');
  });

  test('a command keeps its LF and TAB; CR, bidi and zero-width characters become escapes; the preview still ends at the first LF', () => {
    const command = 'echo ok\r\u{202E}hs.txt\u{200B}\tx\nmake deploy';
    const a = ticketApproval({ ...details, commands: [{ command, cwd: '/work/site', literal: false }] }, 'en');
    assert.deepEqual(a.commands[0], {
      short: 'echo ok\\u{000D}\\u{202E}hs.txt\\u{200B}\tx…',
      full: 'echo ok\\u{000D}\\u{202E}hs.txt\\u{200B}\tx\nmake deploy',
      cwd: '/work/site',
      literal: false,
    });
  });

  test('a directory cannot forge a line: its LF becomes an escape, its TAB stays', () => {
    const a = ticketApproval({ ...details, commands: [{ command: 'make', cwd: '/work/a\nCommand · /etc\tb', literal: false }] }, 'en');
    assert.equal(a.commands[0]?.cwd, '/work/a\\u{000A}Command · /etc\tb');
  });

  test('the start directory keeps its TAB, the agent row keeps no hidden character: neither can forge a line or reorder text', () => {
    const a = ticketApproval(
      {
        ...details,
        session: { ...details.session, startDir: '/work/a\nAccount · x\t\u{202E}b' },
        agent: { id: 'agent-1', type: 'general\npurpose\t\u{202E}x\u{200B}' },
      },
      'en',
    );
    const shown = Object.fromEntries(a.rows.map(([label, value]) => [label, value]));
    assert.equal(shown['Started in'], '/work/a\\u{000A}Account · x\t\\u{202E}b');
    assert.equal(shown['Agent'], 'subagent · general\\u{000A}purpose\\u{0009}\\u{202E}x\\u{200B}');
    const byId = ticketApproval({ ...details, agent: { id: 'agent-\u{202E}7' } }, 'en');
    assert.deepEqual(byId.rows[2], ['Agent', 'subagent · agent-\\u{202E}7']);
  });

  test('an escape keeps a surrogate pair whole and has at least four uppercase hex digits', () => {
    const a = ticketApproval({ ...details, reason: 'key \u{1F511} \u{E0041}\u{0007}\u{00AD}\u{FEFF}' }, 'en');
    assert.equal(a.reason, 'key \u{1F511} \\u{E0041}\\u{0007}\\u{00AD}\\u{FEFF}');
  });

  test('uses the Ukrainian labels', () => {
    const a = ticketApproval(details, 'uk');
    assert.deepEqual(a.rows[2], ['Агент', 'main']);
    assert.deepEqual(a.labels, { command: 'Команда', literal: 'Команда з цим квитком', expand: 'Показати повністю' });
  });
});

describe('commands in the window', () => {
  test('a command is collapsed to its first line, up to 100 characters', () => {
    assert.equal(commandPreview('make deploy'), 'make deploy');
    assert.equal(commandPreview('set -e\nmake deploy'), 'set -e…');
    assert.equal(commandPreview('x'.repeat(150)), `${'x'.repeat(100)}…`);
  });

  test('zenity shows the whole command, capped at 40 lines', async () => {
    const long = Array.from({ length: 45 }, (_, i) => `echo ${i}`).join('\n');
    const run = fakeRunner([{ kind: 'exit', code: 0, stdout: '' }]);
    const a = { ...APPROVAL, commands: [{ short: commandPreview(long), full: long, cwd: '/work', literal: true }] };
    await platformDialog(run, 'linux', ROOT).ask(a);
    const text = (run.calls[0] as Call).args.find((arg) => arg.startsWith('--text=')) ?? '';
    assert.ok(text.includes('<b>Command naming this ticket</b>  /work\n<tt>echo 0\n'));
    assert.ok(text.includes('echo 39\n…</tt>'));
    assert.ok(!text.includes('echo 40'));
    assert.equal(cappedLines('a\nb', 40), 'a\nb');
  });
});

describe('cancel', () => {
  function waitingRunner(): { run: Runner; started: string[] } {
    const started: string[] = [];
    const run: Runner = (command, _args, _timeoutMs, signal) =>
      new Promise((resolve) => {
        started.push(command);
        signal?.addEventListener('abort', () => resolve({ kind: 'error' }), { once: true });
      });
    return { run, started };
  }

  test('an abort closes the open window and answers cancelled', async () => {
    const { run, started } = waitingRunner();
    const dialog = platformDialog(run, 'linux', ROOT);
    const cancel = new AbortController();
    const answer = dialog.ask(APPROVAL, cancel.signal);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(started.length, 1);
    cancel.abort();
    assert.equal(await answer, 'cancelled');
  });

  test('a queued window that is cancelled leaves the queue at once and is never shown', async () => {
    const { run, started } = waitingRunner();
    const dialog = platformDialog(run, 'linux', ROOT);
    const first = new AbortController();
    const second = new AbortController();
    const open = dialog.ask(APPROVAL, first.signal);
    const queued = dialog.ask(APPROVAL, second.signal);
    second.abort();
    assert.equal(await queued, 'cancelled');
    first.abort();
    assert.equal(await open, 'cancelled');
    assert.equal(started.length, 1);
  });

  test('cancelling the open window lets the next queued ask show its window', { timeout: 5000 }, async () => {
    const run = fakeRunner([untilKilled, { kind: 'exit', code: 0, stdout: 'approve' }]);
    const dialog = platformDialog(run, 'darwin', ROOT);
    const first = new AbortController();
    const open = dialog.ask(APPROVAL, first.signal);
    const queued = dialog.ask({ ...APPROVAL, reason: 'queued' }, new AbortController().signal);
    await tick();
    assert.equal(run.calls.length, 1);
    first.abort();
    assert.equal(await open, 'cancelled');
    assert.equal(await queued, 'approve');
    assert.equal(run.calls.length, 2);
    assert.equal((JSON.parse(run.calls[1]?.args[3] as string) as Approval).reason, 'queued');
  });

  test('an answered ask leaves no listener on its signal', async () => {
    const run = fakeRunner([{ kind: 'exit', code: 0, stdout: 'approve' }]);
    const cancel = new AbortController();
    assert.equal(await platformDialog(run, 'darwin', ROOT).ask(APPROVAL, cancel.signal), 'approve');
    assert.equal(getEventListeners(cancel.signal, 'abort').length, 0);
  });

  test('an already cancelled ask starts nothing', async () => {
    const { run, started } = waitingRunner();
    const cancel = new AbortController();
    cancel.abort();
    assert.equal(await platformDialog(run, 'linux', ROOT).ask(APPROVAL, cancel.signal), 'cancelled');
    assert.equal(started.length, 0);
  });
});

describe('runCommand without a timeout', () => {
  test('runs to the end', async () => {
    assert.deepEqual(await runCommand('sh', ['-c', 'printf ok'], undefined), { kind: 'exit', code: 0, stdout: 'ok' });
  });
});

describe('macOS window script', () => {
  test('has the expand control for long commands', () => {
    const source = readFileSync(new URL('../../dialog/macos-window.js', import.meta.url), 'utf8');
    assert.match(source, /'expand:'/);
    assert.match(source, /data\.commands/);
  });

  test('offers expand when the collapsed line is cut at the window width, not only when it is not the whole command', () => {
    // JXA cannot run in CI, so this reads the script itself.
    const source = readFileSync(new URL('../../dialog/macos-window.js', import.meta.url), 'utf8');
    const view = source.slice(source.indexOf('function commandView'), source.indexOf('function run('));
    assert.match(view, /const truncated = short\.intrinsicContentSize\.width > width;/);
    assert.ok(view.indexOf('intrinsicContentSize') < view.indexOf('fixSize(short'), 'measured before the width is pinned');
    assert.match(view, /if \(truncated \|\| cmd\.short !== cmd\.full\)/);
  });

  test('expanding keeps the window top-left corner in place', () => {
    const source = readFileSync(new URL('../../dialog/macos-window.js', import.meta.url), 'utf8');
    const expand = source.slice(source.indexOf("'expand:'"), source.indexOf('function label('));
    assert.match(expand, /const topLeft = \$\.NSMakePoint\(frame\.origin\.x, frame\.origin\.y \+ frame\.size\.height\);/);
    const resize = expand.indexOf('panel.setContentSize(');
    assert.ok(resize > 0, 'the window is resized');
    assert.ok(expand.indexOf('const topLeft') < resize, 'read before the resize');
    assert.ok(resize < expand.indexOf('panel.setFrameTopLeftPoint(topLeft)'), 'restored after it');
  });
});

describe('runCommand', () => {
  const node = process.execPath;

  test('returns the exit code and stdout', async () => {
    assert.deepEqual(await runCommand(node, ['-e', 'process.stdout.write("approve\\n")'], 5000), {
      kind: 'exit',
      code: 0,
      stdout: 'approve\n',
    });
    assert.deepEqual(await runCommand(node, ['-e', 'process.exit(5)'], 5000), { kind: 'exit', code: 5, stdout: '' });
  });

  test('kills the command at the timeout', async () => {
    const started = Date.now();
    assert.deepEqual(await runCommand(node, ['-e', 'setTimeout(() => {}, 60000)'], 200), { kind: 'timeout' });
    assert.ok(Date.now() - started < 5000);
  });

  test('reports a missing command', async () => {
    assert.deepEqual(await runCommand('/nonexistent/1password-bridge-no-such-command', [], 1000), { kind: 'missing' });
  });

  test('an abort kills the command at once', { timeout: 10000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'op-dlg-'));
    try {
      const pidFile = join(dir, 'pid');
      const controller = new AbortController();
      const script = `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setTimeout(() => {}, 60000)`;
      const result = runCommand(node, ['-e', script], 60000, controller.signal);
      let pid = 0;
      for (let i = 0; i < 500 && pid === 0; i++) {
        pid = existsSync(pidFile) ? Number(readFileSync(pidFile, 'utf8')) || 0 : 0;
        if (pid === 0) await wait(10);
      }
      assert.ok(pid > 0, 'the command started');
      controller.abort();
      assert.deepEqual(await result, { kind: 'error' });
      const alive = (): boolean => {
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      };
      for (let i = 0; i < 200 && alive(); i++) await wait(10);
      assert.equal(alive(), false, 'the command is gone');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('an already aborted signal starts nothing', async () => {
    // Spawning the missing command would answer `missing`; nothing is spawned, so it is `error`.
    assert.deepEqual(await runCommand('/nonexistent/1password-bridge-no-such-command', [], 1000, AbortSignal.abort()), { kind: 'error' });
  });
});
