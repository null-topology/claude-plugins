/**
 * The start steps model, effort and kiro_mode when Kiro offers their option
 * only after its `session/new` answer (`fake-late-options`): each step waits
 * within its cap, and only an option still missing at the cap, or a value the
 * offered option does not list, is E_INVALID.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import { SidecarError } from '../../src/errors.ts';
import { readCall } from '../../src/store/runs.ts';
import { PROCESS_TIMEOUT, isAlive, managerFixture, metaOf, waitFor } from './manager-helpers.ts';
import type { ManagerFixture, ManagerFixtureOptions } from './manager-helpers.ts';

interface ConfigEntry {
  readonly event: string;
  readonly ids?: readonly string[];
  readonly configId?: string;
  readonly value?: unknown;
}

/** The late offers, config changes and prompts the fake logged, in order. */
async function configLog(dir: string): Promise<ConfigEntry[]> {
  let text: string;
  try {
    text = await readFile(join(dir, 'fake-config.jsonl'), 'utf8');
  } catch {
    return [];
  }
  return text
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as ConfigEntry);
}

/** A fixture whose fake offers the options `late` names (`<ids> <ms>` or `<ids> never`) after its answer. */
async function fixtureWith(t: TestContext, late: string, options: ManagerFixtureOptions = {}): Promise<ManagerFixture> {
  const fixture = await managerFixture(t, 'default', options);
  await writeFile(join(fixture.workspace.dir, 'fake-late-options'), late);
  return fixture;
}

async function onlyRun(fixture: ManagerFixture): Promise<string> {
  const ids = await readdir(join(fixture.stateDir, 'runs')).catch(() => [] as string[]);
  assert.equal(ids.length, 1, `runs: ${ids.join(', ')}`);
  return ids[0] as string;
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

/** The cleanup every failed start step gets, as the other failed-step tests assert it. */
async function assertCleanedUp(fixture: ManagerFixture, launchId: string): Promise<void> {
  const meta = await metaOf(fixture.stateDir, launchId);
  assert.equal(meta.state, 'failed');
  assert.equal(fixture.spawned.length, 1, `spawned: ${fixture.spawned.join(', ')}`);
  const pid = fixture.spawned[0] as number;
  await waitFor(() => !isAlive(pid), 'the fake to be gone', 5_000);
  assert.equal(await exists(join(fixture.stateDir, 'runs', launchId, 'lock')), false);
  assert.equal(fixture.manager.get(launchId), undefined);
  assert.deepEqual(fixture.manager.list(), []);
}

function invalidOn(field: string, message: string | RegExp): (error: unknown) => boolean {
  return (error) => {
    assert.ok(error instanceof SidecarError, `unexpected ${String(error)}`);
    assert.equal(error.code, 'E_INVALID', error.message);
    if (typeof message === 'string') {
      assert.equal(error.message, message);
    } else {
      assert.match(error.message, message);
    }
    assert.ok(error.message.startsWith(`${field} `), error.message);
    return true;
  };
}

describe('SessionManager.start: options Kiro offers after session/new', () => {
  for (const [field, configId, params, read] of [
    ['model', 'model', { model: 'claude-opus-5.5' }, { model: 'claude-opus-5.5' }],
    ['effort', 'effortLevel', { effort: 'high' }, { effort: 'high' }],
    ['kiro_mode', 'mode', { kiro_mode: 'spec' }, { kiroMode: 'spec' }],
  ] as const) {
    test(`${field}: offered 300 ms after the answer, the step waits, sets it, reads it back, then prompts`, PROCESS_TIMEOUT, async (t) => {
      const fixture = await fixtureWith(t, `${configId} 300`);
      const result = await fixture.manager.start({ dir: fixture.workspace.dir, prompt: 'hello', ...params });
      for (const [key, value] of Object.entries(read)) {
        assert.equal((result as unknown as Record<string, unknown>)[key], value, key);
        assert.equal((await metaOf(fixture.stateDir, result.launchId) as unknown as Record<string, unknown>)[key], value, key);
      }
      await waitFor(async () => (await configLog(fixture.workspace.dir)).some((entry) => entry.event === 'prompt'), 'the prompt');
      assert.deepEqual(await configLog(fixture.workspace.dir), [
        { event: 'offered', ids: [configId] },
        { event: 'set', configId, value: Object.values(params)[0] },
        { event: 'prompt' },
      ]);
    });
  }

  test('model never offered: E_INVALID at the step cap, no prompt, and the cleanup of a failed step', PROCESS_TIMEOUT, async (t) => {
    const fixture = await fixtureWith(t, 'model never', { startLimits: { configMs: 500 } });
    const started = performance.now();
    await assert.rejects(
      fixture.manager.start({ dir: fixture.workspace.dir, prompt: 'hello', model: 'claude-opus-5.5' }, { toolUseId: 'toolu_late' }),
      invalidOn(
        'model',
        'model is not offered by Kiro: No config option "model"; offered options: mode, memoryReflection, autopilot, contentCollection',
      ),
    );
    assert.ok(performance.now() - started >= 500, 'the step waited out its cap');
    const launchId = await onlyRun(fixture);
    await assertCleanedUp(fixture, launchId);
    const call = (await readCall(fixture.stateDir, 'toolu_late')) as { error: string; failed: boolean };
    assert.equal(call.failed, true);
    assert.ok(call.error.startsWith('E_INVALID'), JSON.stringify(call));
    assert.deepEqual(await configLog(fixture.workspace.dir), []);
  });

  for (const [what, late] of [
    ['offered in the answer', null],
    ['offered 300 ms after the answer', 'model 300'],
  ] as const) {
    test(`a model value the option does not list (${what}) is E_INVALID without waiting out the cap`, PROCESS_TIMEOUT, async (t) => {
      const options = { startLimits: { configMs: 20_000 } };
      const fixture = late === null ? await managerFixture(t, 'default', options) : await fixtureWith(t, late, options);
      const started = performance.now();
      await assert.rejects(
        fixture.manager.start({ dir: fixture.workspace.dir, prompt: 'hello', model: 'gpt-x' }),
        invalidOn('model', /^model is not offered by Kiro: Config option "model" does not offer "gpt-x"; offered values: auto, /),
      );
      const elapsed = performance.now() - started;
      assert.ok(elapsed < 10_000, `failed after ${Math.round(elapsed)} ms`);
      await assertCleanedUp(fixture, await onlyRun(fixture));
    });
  }

  // Measured: the model `auto` has no effort levels, so Kiro never offers
  // effortLevel with it and the step does not wait for it.
  for (const [what, late, params] of [
    ['auto offered in the answer', null, { effort: 'high' }],
    ['auto set by the start', null, { model: 'auto', effort: 'high' }],
    ['auto offered 300 ms after the answer', 'model 300', { effort: 'high' }],
  ] as const) {
    test(`an effort with the model ${what} is E_INVALID without waiting out the cap`, PROCESS_TIMEOUT, async (t) => {
      // The default 15 s step cap.
      const fixture = late === null ? await managerFixture(t, 'default') : await fixtureWith(t, late);
      const started = performance.now();
      await assert.rejects(
        fixture.manager.start({ dir: fixture.workspace.dir, prompt: 'hello', ...params }),
        invalidOn(
          'effort',
          /^effort is not offered by Kiro: No config option "effortLevel"; offered options: [^;]*model[^;]*; model "auto" has no effort levels$/,
        ),
      );
      const elapsed = performance.now() - started;
      assert.ok(elapsed < 2_000, `failed after ${Math.round(elapsed)} ms`);
      await assertCleanedUp(fixture, await onlyRun(fixture));
    });
  }

  for (const prompt of ['hello', null] as const) {
    test(`a model offered after the answer is read back once the tool server is up (${prompt === null ? 'idle' : 'prompted'})`, PROCESS_TIMEOUT, async (t) => {
      // The model comes at 300 ms, the tool server at 600 ms; no start
      // argument waits for the model.
      const fixture = await fixtureWith(t, 'model 300');
      await writeFile(join(fixture.workspace.dir, 'fake-mcp-status'), 'late 600');
      const result = await fixture.manager.start({ dir: fixture.workspace.dir, ...(prompt === null ? {} : { prompt }) });
      const meta = await metaOf(fixture.stateDir, result.launchId);
      for (const [where, read] of [
        ['reply', result],
        ['meta', meta],
      ] as const) {
        assert.equal(read.model, 'auto', where);
        assert.equal(read.effort, null, where);
        assert.equal(read.kiroMode, 'vibe', where);
      }
    });
  }
});
