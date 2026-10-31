import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { BRIDGE_TOOL, preToolUse } from '../../src/hooks/pre-tool-use.ts';
import { context, sandbox, SESSION_ID, OTHER_SESSION_ID, type Sandbox } from './helpers.ts';

let box: Sandbox;

beforeEach(() => {
  box = sandbox();
});

afterEach(() => {
  box.cleanup();
});

function input(toolName: string, toolInput: unknown, sessionId: unknown = SESSION_ID) {
  return {
    hook_event_name: 'PreToolUse',
    session_id: sessionId,
    transcript_path: '/transcripts/live.jsonl',
    cwd: '/work',
    tool_name: toolName,
    tool_input: toolInput,
  };
}

describe('BRIDGE_TOOL', () => {
  test('matches the three session-bound tools of this plugin only', () => {
    for (const tool of ['fields', 'issue_tickets', 'release']) {
      assert.ok(BRIDGE_TOOL.test(`mcp__plugin_1password-bridge_op__${tool}`), tool);
    }
    for (const name of [
      'Bash',
      'Monitor',
      'mcp__plugin_1password-bridge_op__accounts',
      'mcp__plugin_other_op__issue_tickets',
      'xmcp__plugin_1password-bridge_op__issue_tickets',
    ]) {
      assert.ok(!BRIDGE_TOOL.test(name), name);
    }
  });
});

describe('preToolUse', () => {
  test('injects the live session id and transcript path into a bridge tool call', () => {
    const out = preToolUse(context(box.stateDir, input('mcp__plugin_1password-bridge_op__issue_tickets', { ref: 'op://V/I/f', reason: 'deploy' })));
    assert.deepEqual(out, {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        updatedInput: { ref: 'op://V/I/f', reason: 'deploy', session_id: SESSION_ID, transcript_path: '/transcripts/live.jsonl', cwd: '/work', agent_id: 'main' },
      },
    });
  });

  test('needs no session state on disk', () => {
    const out = preToolUse(context(box.stateDir, input('mcp__plugin_1password-bridge_op__fields', { ref: 'op://V/I' })));
    assert.equal(out?.hookSpecificOutput?.hookEventName, 'PreToolUse');
  });

  test('overrides a session id the model supplied itself', () => {
    const out = preToolUse(
      context(
        box.stateDir,
        input('mcp__plugin_1password-bridge_op__release', { tickets: ['tkt_aaaaaaaaaaaaaaaa'], session_id: OTHER_SESSION_ID, transcript_path: '/elsewhere' }),
      ),
    );
    assert.deepEqual(out?.hookSpecificOutput?.updatedInput, {
      tickets: ['tkt_aaaaaaaaaaaaaaaa'],
      session_id: SESSION_ID,
      transcript_path: '/transcripts/live.jsonl',
      cwd: '/work',
      agent_id: 'main',
    });
  });

  test('an invalid live session id strips any model-supplied session fields', () => {
    const out = preToolUse(
      context(box.stateDir, input('mcp__plugin_1password-bridge_op__issue_tickets', { ref: 'r', session_id: OTHER_SESSION_ID }, '../escape')),
    );
    assert.deepEqual(out?.hookSpecificOutput?.updatedInput, { ref: 'r', transcript_path: '/transcripts/live.jsonl', cwd: '/work', agent_id: 'main' });
  });

  test('injects the agent, its type and the cwd, overwriting what the model passed', () => {
    const out = preToolUse(
      context('/state', {
        hook_event_name: 'PreToolUse',
        session_id: SESSION_ID,
        transcript_path: '/t.jsonl',
        agent_id: 'agent-1',
        agent_type: 'general-purpose',
        cwd: '/work/site',
        tool_name: 'mcp__plugin_1password-bridge_op__issue_tickets',
        tool_input: { ref: 'op://a/b/c', reason: 'x', agent_id: 'main', cwd: '/elsewhere' },
      }),
    );
    assert.deepEqual(out?.hookSpecificOutput?.updatedInput, {
      ref: 'op://a/b/c',
      reason: 'x',
      session_id: SESSION_ID,
      transcript_path: '/t.jsonl',
      agent_type: 'general-purpose',
      cwd: '/work/site',
      agent_id: 'agent-1',
    });
  });

  test('a model-supplied agent type is dropped when the payload has none', () => {
    const out = preToolUse(context(box.stateDir, input('mcp__plugin_1password-bridge_op__release', { tickets: ['t'], agent_type: 'Explore', agent_id: 'agent-9' })));
    assert.deepEqual(out?.hookSpecificOutput?.updatedInput, { tickets: ['t'], session_id: SESSION_ID, transcript_path: '/transcripts/live.jsonl', cwd: '/work', agent_id: 'main' });
  });

  // Every hook-owned field the model writes, for each bridge tool: the payload's value wins, and
  // without a usable payload value the model's is dropped (agent_id falls back to `main`).
  const TOOL_INPUTS: Record<string, Record<string, unknown>> = {
    fields: { ref: 'op://V/I' },
    issue_tickets: { ref: 'op://V/I/f', reason: 'deploy', count: 2 },
    release: { tickets: ['tkt_aaaaaaaaaaaaaaaa'] },
  };
  const MODEL_SUPPLIED = { session_id: OTHER_SESSION_ID, transcript_path: '/elsewhere.jsonl', agent_id: 'agent-model', agent_type: 'Explore', cwd: '/elsewhere' };
  const LIVE = { session_id: SESSION_ID, transcript_path: '/t.jsonl', agent_id: 'agent-1', agent_type: 'general-purpose', cwd: '/work/site' };
  const UNUSABLE: Record<string, Record<string, unknown>> = {
    missing: {},
    'not strings': { session_id: 42, transcript_path: null, agent_id: false, agent_type: { name: 'Explore' }, cwd: ['/work'] },
    empty: { session_id: '', transcript_path: '', agent_id: '', agent_type: '', cwd: '' },
  };

  function injected(tool: string, toolInput: Record<string, unknown>, payload: Record<string, unknown>): unknown {
    const out = preToolUse(
      context(box.stateDir, {
        hook_event_name: 'PreToolUse',
        ...payload,
        tool_name: `mcp__plugin_1password-bridge_op__${tool}`,
        tool_input: { ...toolInput, ...MODEL_SUPPLIED },
      }),
    );
    return out?.hookSpecificOutput?.updatedInput;
  }

  for (const [tool, toolInput] of Object.entries(TOOL_INPUTS)) {
    test(`${tool}: the payload's session, transcript, agent, agent type and cwd replace the model's`, () => {
      assert.deepEqual(injected(tool, toolInput, LIVE), { ...toolInput, ...LIVE });
    });

    test(`${tool}: without usable payload values the model's are dropped and the agent is main`, () => {
      for (const [label, payload] of Object.entries(UNUSABLE)) {
        assert.deepEqual(injected(tool, toolInput, payload), { ...toolInput, agent_id: 'main' }, label);
      }
    });
  }

  test('other tools are left alone', () => {
    for (const tool of ['Bash', 'Monitor', 'mcp__plugin_1password-bridge_op__accounts']) {
      assert.equal(preToolUse(context(box.stateDir, input(tool, { command: 'echo hi' }))), undefined, tool);
    }
  });

  test('a tool input that is not an object is left alone', () => {
    assert.equal(preToolUse(context(box.stateDir, input('mcp__plugin_1password-bridge_op__issue_tickets', 'text'))), undefined);
    assert.equal(preToolUse(context(box.stateDir, input('mcp__plugin_1password-bridge_op__issue_tickets', ['a']))), undefined);
  });
});
