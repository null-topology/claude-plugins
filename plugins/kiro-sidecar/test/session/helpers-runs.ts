import { existsSync } from 'node:fs';
import { rm, writeFile } from 'node:fs/promises';
import { currentDriver } from '../../src/store/identity.ts';
import type { ProcessIdentity } from '../../src/store/identity.ts';
import { writeJsonAtomic } from '../../src/store/files.ts';
import { runPaths, turnPaths } from '../../src/store/paths.ts';
import { createRun, createTurnResult } from '../../src/store/runs.ts';
import type { RunMeta } from '../../src/store/runs.ts';
import type { QueryDeps } from '../../src/session/queries.ts';
import type { LiveRegistry, LiveSession, TurnResult } from '../../src/session/types.ts';

export const HOME = 'test-home';
export const OWNER = 'pid-4242-123456@test-host:boot:1';

/** A driver on a host other than this one. */
export const OTHER_HOST_DRIVER: ProcessIdentity = {
  pid: 4242,
  startTime: '777',
  hostId: 'far-host:boot:9',
};

let createdCounter = 0;

/** A creation time later than every one handed out before. */
export function nextCreatedAt(): string {
  createdCounter += 1;
  return new Date(Date.UTC(2026, 9, 18, 0, 0, createdCounter)).toISOString();
}

/** Creates a run directory and writes its `meta.json`; own, idle and alive by default. */
export async function writeRun(
  stateDir: string,
  overrides: Partial<RunMeta> = {},
): Promise<RunMeta> {
  const { launchId } = await createRun(stateDir);
  const createdAt = overrides.createdAt ?? nextCreatedAt();
  const meta: RunMeta = {
    launchId,
    kiroSessionId: `sess-${launchId.slice(3)}`,
    ownerKey: OWNER,
    driver: await currentDriver(),
    home: HOME,
    projectDir: '/work/app',
    label: 'review',
    mode: 'docker',
    dir: '/work/app',
    dirReadOnly: false,
    mounts: [],
    skills: [],
    steering: [],
    model: null,
    effort: null,
    kiroMode: null,
    permissions: 'allow',
    preset: null,
    tokenSource: 'api_key',
    image: 'example/kiro-image:1.2.3',
    dockerUser: 'auto',
    containerName: `kiro-sidecar-${launchId.slice(3)}`,
    child: null,
    state: 'idle',
    currentTurn: 0,
    firstPromptPreview: null,
    createdAt,
    updatedAt: createdAt,
    ...overrides,
  };
  await writeJsonAtomic(runPaths(stateDir, launchId).meta, meta);
  return meta;
}

export function sampleResult(
  meta: RunMeta,
  turn: number,
  overrides: Partial<TurnResult> = {},
): TurnResult {
  return {
    launchId: meta.launchId,
    sessionId: meta.kiroSessionId ?? 'sess-unknown',
    label: meta.label,
    turn,
    outcome: 'end_turn',
    endedBy: null,
    startedAt: '2026-10-18T00:31:23Z',
    endedAt: '2026-10-18T00:35:33Z',
    durationS: 250,
    toolCalls: 2,
    lastTool: 'read_file: README.md',
    messages: [],
    messagesDropped: 0,
    completion: null,
    final: 'Done.',
    textChars: 0,
    truncated: false,
    error: null,
    stderrTail: null,
    ...overrides,
  };
}

/** Writes `turns/<turn>.md` (unless `text` is null) and then `turns/<turn>.json`. */
export async function writeTurn(
  stateDir: string,
  meta: RunMeta,
  turn: number,
  text: string | null = 'Done.',
  overrides: Partial<TurnResult> = {},
): Promise<TurnResult> {
  const paths = turnPaths(stateDir, meta.launchId, turn);
  if (text !== null) {
    await writeFile(paths.text, text, 'utf8');
  }
  const result = sampleResult(meta, turn, { textChars: text?.length ?? 0, ...overrides });
  await createTurnResult(stateDir, meta.launchId, turn, result);
  return result;
}

/** A live registry the test fills by hand. */
export class FakeRegistry implements LiveRegistry {
  readonly sessions = new Map<string, LiveSession>();

  get(launchId: string): LiveSession | undefined {
    return this.sessions.get(launchId);
  }

  list(): readonly LiveSession[] {
    return [...this.sessions.values()];
  }

  put(session: LiveSession): void {
    this.sessions.set(session.launchId, session);
  }
}

export function liveSession(
  launchId: string,
  overrides: Partial<LiveSession> = {},
): LiveSession {
  return {
    launchId,
    state: 'idle',
    currentTurn: 0,
    runningTurn: null,
    permissionsAnswered: { allowed: 0, denied: 0 },
    ...overrides,
  };
}

export interface ClaimEvent {
  readonly launchId: string;
  readonly turn: number;
  /** Whether `turns/<n>.json` existed when the claim was taken. */
  readonly resultAtClaim: boolean;
}

export interface ReleaseEvent {
  readonly launchId: string;
  readonly turn: number;
  /** Whether `turns/<n>.returned` existed when the claim was released. */
  readonly returnedAtRelease: boolean;
}

export interface ClaimLog {
  readonly claims: ClaimEvent[];
  readonly releases: ReleaseEvent[];
}

/** A claim that writes `turns/<n>.claimed` and removes it on release, logging both. */
export function fileClaims(stateDir: string): { claim: QueryDeps['claim']; log: ClaimLog } {
  const log: ClaimLog = { claims: [], releases: [] };
  const claim: QueryDeps['claim'] = async (launchId, turn) => {
    const paths = turnPaths(stateDir, launchId, turn);
    log.claims.push({ launchId, turn, resultAtClaim: existsSync(paths.result) });
    await writeFile(paths.claimed, '{}\n', { mode: 0o600 });
    return async () => {
      log.releases.push({ launchId, turn, returnedAtRelease: existsSync(paths.returned) });
      await rm(paths.claimed, { force: true });
    };
  };
  return { claim, log };
}

export interface TestDeps {
  readonly deps: QueryDeps;
  readonly registry: FakeRegistry;
  readonly log: ClaimLog;
}

export function makeDeps(stateDir: string, overrides: Partial<QueryDeps> = {}): TestDeps {
  const registry = new FakeRegistry();
  const { claim, log } = fileClaims(stateDir);
  const deps: QueryDeps = {
    stateDir,
    home: HOME,
    owner: OWNER,
    live: registry,
    claim,
    pollMs: 10,
    ...overrides,
  };
  return { deps, registry, log };
}

/** Resolves after `ms` milliseconds. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
