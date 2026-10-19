import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { Environment } from '../src/settings.ts';
import { TOOLS } from '../src/tools/tools.ts';
import { tempDir } from './helpers/processes.ts';
import { hookLogLines } from './hooks/helpers.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PLUGIN_ROOT = '${CLAUDE_PLUGIN_ROOT}/';

interface CommandHook {
  readonly type: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly timeout: number;
  readonly asyncRewake?: boolean;
}

interface HookGroup {
  readonly matcher: string;
  readonly hooks: readonly CommandHook[];
}

interface HooksFile {
  readonly hooks: Record<string, readonly HookGroup[]>;
}

interface McpConfig {
  readonly mcpServers: Record<string, { readonly args: readonly string[] }>;
}

function readText(relativePath: string): string {
  return readFileSync(join(ROOT, relativePath), 'utf8');
}

function readJson<T>(relativePath: string): T {
  return JSON.parse(readText(relativePath)) as T;
}

const HOOKS = readJson<HooksFile>('hooks/hooks.json');

function onlyGroup(event: string): HookGroup {
  const groups = HOOKS.hooks[event] ?? [];
  assert.equal(groups.length, 1, `one ${event} group`);
  const [group] = groups;
  assert.ok(group !== undefined);
  return group;
}

function onlyHook(event: string): CommandHook {
  const { hooks } = onlyGroup(event);
  assert.equal(hooks.length, 1, `one ${event} hook`);
  const [hook] = hooks;
  assert.ok(hook !== undefined);
  return hook;
}

/** `mcp__plugin_<plugin name>_<server key>__`, the prefix the client gives the server's tools. */
function toolNamePrefix(): string {
  const plugin = readJson<{ name: string }>('.claude-plugin/plugin.json');
  const servers = Object.keys(readJson<McpConfig>('.mcp.json').mcpServers);
  assert.equal(servers.length, 1, 'one MCP server');
  return `mcp__plugin_${plugin.name}_${servers[0] ?? ''}__`;
}

/** The `ENTRY_POINTS` list of the build script. */
function entryPoints(): string[] {
  const match = /const ENTRY_POINTS = \[([^\]]*)\]/.exec(readText('scripts/build.mjs'));
  assert.ok(match !== null, 'the build script declares ENTRY_POINTS');
  return [...(match[1] ?? '').matchAll(/'([^']+)'/g)].map((entry) => entry[1] ?? '');
}

/** `src/<name>.ts` is built to `dist/<name>.js`. */
function bundleOf(entry: string): string {
  const match = /^src\/([^/]+)\.ts$/.exec(entry);
  assert.ok(match !== null, `${entry} is a file directly in src/`);
  return `dist/${match[1] ?? ''}.js`;
}

/** The plugin-relative path of every bundled program a config file runs. */
function programsRun(groups: readonly { readonly args: readonly string[] }[]): string[] {
  return groups
    .flatMap((entry) => entry.args)
    .filter((arg) => arg.startsWith(PLUGIN_ROOT))
    .map((arg) => arg.slice(PLUGIN_ROOT.length));
}

describe('hooks.json', () => {
  test('declares the waiter after start and send, and the context hook on session start', () => {
    assert.deepEqual(HOOKS, {
      hooks: {
        PostToolUse: [
          {
            matcher: '^mcp__plugin_kiro-sidecar_kiro__(start|send)$',
            hooks: [
              {
                type: 'command',
                command: 'node',
                args: ['${CLAUDE_PLUGIN_ROOT}/dist/waiter.js', '--deadline-s', '3540'],
                asyncRewake: true,
                timeout: 3600,
              },
            ],
          },
        ],
        SessionStart: [
          {
            matcher: '^(clear|resume|fork|compact)$',
            hooks: [
              {
                type: 'command',
                command: 'node',
                args: ['${CLAUDE_PLUGIN_ROOT}/dist/context.js'],
                timeout: 10,
              },
            ],
          },
        ],
      },
    });
  });

  test('the waiter deadline is the hook timeout less 60 s', () => {
    const waiter = onlyHook('PostToolUse');
    assert.equal(typeof waiter.timeout, 'number');
    const at = waiter.args.indexOf('--deadline-s');
    assert.notEqual(at, -1, 'the waiter is given --deadline-s');
    const deadline = waiter.args[at + 1] ?? '';
    assert.match(deadline, /^[1-9]\d*$/);
    assert.equal(Number(deadline), waiter.timeout - 60);
  });

  test('the PostToolUse matcher selects start and send among the server tools, and no other', () => {
    const matcher = new RegExp(onlyGroup('PostToolUse').matcher);
    const prefix = toolNamePrefix();
    const names = TOOLS.map((tool) => tool.name);
    assert.ok(names.length > 2, 'the server has other tools');
    assert.deepEqual(
      names.filter((name) => matcher.test(`${prefix}${name}`)),
      ['start', 'send'],
    );
    for (const name of ['start', 'send']) {
      for (const other of [name, `${prefix}${name}x`, `x${prefix}${name}`, `${prefix.replace('kiro__', 'other__')}${name}`]) {
        assert.equal(matcher.test(other), false, other);
      }
    }
  });

  test('the SessionStart matcher selects every source but startup', () => {
    const matcher = new RegExp(onlyGroup('SessionStart').matcher);
    for (const source of ['clear', 'resume', 'fork', 'compact']) {
      assert.equal(matcher.test(source), true, source);
    }
    for (const source of ['startup', '', 'xclear', 'clearx']) {
      assert.equal(matcher.test(source), false, source);
    }
  });

  test('every program a hook or the MCP config runs is a built entry point', () => {
    const bundles = entryPoints().map(bundleOf);
    const hookPrograms = programsRun(Object.values(HOOKS.hooks).flatMap((groups) => groups.flatMap((group) => group.hooks)));
    assert.deepEqual(hookPrograms, ['dist/waiter.js', 'dist/context.js']);
    const programs = [...hookPrograms, ...programsRun(Object.values(readJson<McpConfig>('.mcp.json').mcpServers))];
    for (const program of programs) {
      assert.ok(bundles.includes(program), `${program} is built from an ENTRY_POINTS entry`);
      assert.ok(existsSync(join(ROOT, program)), `${program} exists`);
    }
    assert.deepEqual(readdirSync(join(ROOT, 'dist')).sort(), bundles.map((bundle) => bundle.slice('dist/'.length)).sort());
  });

  test('the tools that start the waiter say their result is pushed; wait says when it is needed', () => {
    const matcher = new RegExp(onlyGroup('PostToolUse').matcher);
    const prefix = toolNamePrefix();
    for (const tool of TOOLS) {
      assert.doesNotMatch(tool.description, /not pushed/, tool.name);
      if (matcher.test(`${prefix}${tool.name}`)) {
        assert.match(tool.description, /its result is pushed into the conversation/, tool.name);
        assert.ok(tool.description.includes('"[kiro-sidecar]"'), tool.name);
        // A turn ended by a tool is not pushed: the note says so and where its result is.
        assert.match(tool.description, /ended by cancel, send \{interrupt: true\} or stop gets no push/, tool.name);
        assert.match(tool.description, /reply or with wait/, tool.name);
      } else {
        assert.doesNotMatch(tool.description, /pushed into the conversation/, tool.name);
      }
    }
    const wait = TOOLS.find((tool) => tool.name === 'wait');
    assert.match(wait?.description ?? '', /when no push can come/);
  });
});

interface BundleRun {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs `node dist/<name>` with empty stdin and the given state directory only. */
function runBundle(t: TestContext, name: string, args: readonly string[], stateDir: string): Promise<BundleRun> {
  const env: Environment = { PATH: process.env.PATH ?? '', CLAUDE_PLUGIN_DATA: stateDir };
  const child = spawn(process.execPath, [join(ROOT, 'dist', name), ...args], { stdio: ['pipe', 'pipe', 'pipe'], env });
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
    }
  });
  const stdout: string[] = [];
  const stderr: string[] = [];
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => stdout.push(chunk));
  child.stderr.on('data', (chunk: string) => stderr.push(chunk));
  const closed = new Promise<BundleRun>((resolve) => {
    child.on('close', (code, signal) => resolve({ code, signal, stdout: stdout.join(''), stderr: stderr.join('') }));
  });
  child.stdin.end();
  return closed;
}

describe('bundled hook programs', () => {
  test('dist/waiter.js without arguments: exit 0, no output, one log line', { timeout: 15_000 }, async (t) => {
    const stateDir = await tempDir(t);
    assert.deepEqual(await runBundle(t, 'waiter.js', [], stateDir), { code: 0, signal: null, stdout: '', stderr: '' });
    assert.deepEqual(
      (await hookLogLines(stateDir)).map((line) => [line.hook, line.step, line.reason]),
      [['waiter', 'input', 'bad-arguments']],
    );
  });

  test('dist/context.js with empty stdin: exit 0, no output, one log line', { timeout: 15_000 }, async (t) => {
    const stateDir = await tempDir(t);
    assert.deepEqual(await runBundle(t, 'context.js', [], stateDir), { code: 0, signal: null, stdout: '', stderr: '' });
    assert.deepEqual(
      (await hookLogLines(stateDir)).map((line) => [line.hook, line.step, line.reason]),
      [['context', 'input', 'input-not-json']],
    );
  });
});
