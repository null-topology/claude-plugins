/**
 * The image check before `docker run`, with the image refresh.
 *
 * `docker run` always gets `--pull never`: the image it runs is the local
 * one. To keep a moving tag such as `latest` from staying weeks behind the
 * registry, the check runs `docker pull <reference>` itself at most once per
 * `docker_image_refresh_hours` (default 24) for each reference, so the first
 * docker start of a day may pull the image and take longer. Its limit is
 * `IMAGE_PULL_TIMEOUT_MS` (10 minutes), outside the start deadline; the pull
 * process is ended when it runs out. `0` turns refreshing off: the check
 * then only asks docker whether the image is present, as before. A reference
 * pinned by digest (`@sha256:`) is never pulled.
 *
 * - Present and pulled within the window: nothing is pulled.
 * - A pull that succeeds is recorded; when it replaced the local image (the
 *   id changed), the start reply says so with the old and the new id.
 * - A pull that fails or runs out while the image is present: the start goes
 *   on with the local image, and the reply says that the refresh failed, why,
 *   and which image (id, creation date) is used.
 * - Absent: with refreshing on it is pulled; a failed pull is
 *   `E_IMAGE_MISSING` with the pull command, as with refreshing off, plus the
 *   reason the pull failed.
 * - After a failure no pull of the reference is tried for
 *   `PULL_RETRY_AFTER_MS` (one hour). A pull the server's shutdown ended is
 *   not counted as failed.
 *
 * The record of each reference lives in `<state>/image-pulls/`, under a name
 * derived from the reference, and is written atomically; a missing or
 * unreadable record counts as "never pulled". Starts that need the same pull
 * at the same time in one server process share it.
 */
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { SidecarError } from '../errors.ts';
import type { Environment } from '../settings.ts';
import { ensureDir, readJsonIfExists, writeJsonAtomic } from '../store/files.ts';
import { runDocker, stderrSummary, stripClaudeVariables } from './cli.ts';
import { assertDockerImage } from './launch.ts';

const NO_SUCH_IMAGE = /no such image/i;

/** How long one `docker pull` may run before its process is ended. */
export const IMAGE_PULL_TIMEOUT_MS = 10 * 60_000;

/** How long after a failed pull of a reference no new pull of it is tried. */
export const PULL_RETRY_AFTER_MS = 60 * 60_000;

/** The directory of the pull records, inside the state directory. */
export const PULL_RECORDS_DIR = 'image-pulls';

/** A reason in the start reply or an error is cut to this many characters. */
const REASON_MAX_CHARS = 300;

/** A local image as `docker image inspect` reports it. */
export interface LocalImage {
  /** `sha256:<hex>`. */
  readonly id: string;
  /** The creation date as docker reports it. */
  readonly created: string;
}

/** The docker operations of the check; tests replace them. */
export interface ImageDocker {
  /** The local image, or null when it is absent; throws `E_DOCKER` when docker fails otherwise. */
  inspect(image: string): Promise<LocalImage | null>;
  /**
   * Runs `docker pull`; rejects with an error whose message says why it
   * failed. The process is ended after `timeoutMs` and when `signal` aborts.
   */
  pull(image: string, options: { readonly timeoutMs: number; readonly signal: AbortSignal | undefined }): Promise<void>;
}

/** What the start step gives the check. */
export interface ImageCheckContext {
  readonly stateDir: string;
  /** `docker_image_refresh_hours`; 0 turns refreshing off. */
  readonly refreshHours: number;
  /** Bounds a docker query by the start step's limits. */
  readonly query: <T>(work: Promise<T>) => Promise<T>;
  /** Waits for a pull, outside the start deadline (the pull has its own limit). */
  readonly pull: <T>(work: Promise<T>) => Promise<T>;
  /** Ends a running pull when it aborts (the server shuts down). */
  readonly signal?: AbortSignal;
  readonly docker?: ImageDocker;
  /** Milliseconds since the epoch; tests set the clock. */
  readonly now?: () => number;
}

export interface ImageCheck {
  /** The id of the local image `docker run` starts from. */
  readonly id: string;
  /** What the start reply says about the refresh; null when there is nothing to say. */
  readonly notice: string | null;
}

/** The content of a pull record. */
export interface PullRecord {
  readonly reference: string;
  /** When the last successful pull ended, UTC ISO 8601; null when none is known. */
  readonly pulledAt: string | null;
  /** When the last failed pull ended, if it came after the last success. */
  readonly failedAt: string | null;
  /** Why that pull failed. */
  readonly failure: string | null;
}

/**
 * Checks that `image` is present locally and, with a context whose
 * `refreshHours` is not 0, refreshes it as the header says. Resolves with
 * the local image's id and what the start reply says. Throws `E_INVALID` for
 * a malformed reference, `E_IMAGE_MISSING` (with the exact `docker pull`
 * command) when the image is absent and could not be pulled, and `E_DOCKER`
 * when docker fails otherwise.
 */
export async function checkImage(
  image: string,
  env: Environment = process.env,
  context?: ImageCheckContext,
): Promise<ImageCheck> {
  assertDockerImage(image);
  const docker = context?.docker ?? dockerCli(env);
  const query = context?.query ?? (<T>(work: Promise<T>) => work);
  if (context === undefined || context.refreshHours <= 0 || isDigestPinned(image)) {
    const local = await query(docker.inspect(image));
    if (local === null) {
      throw missingImage(image, null);
    }
    return { id: local.id, notice: null };
  }
  const now = context.now ?? Date.now;
  const windowMs = context.refreshHours * 3_600_000;
  const record = await readPullRecord(context.stateDir, image);
  const before = await query(docker.inspect(image));
  if (before !== null && pulledWithin(record, now(), windowMs)) {
    return { id: before.id, notice: null };
  }
  const blocked = failedWithin(record, now());
  if (blocked !== null) {
    if (before !== null) {
      return { id: before.id, notice: null };
    }
    throw missingImage(image, `the last pull, at ${blocked.failedAt}, failed (${blocked.failure ?? 'no reason recorded'}); the next is tried an hour after it`);
  }
  const outcome = await context.pull(sharedPull(context, image, docker, now, windowMs, before === null));
  const after = await query(docker.inspect(image));
  if (outcome.ok) {
    if (after === null) {
      throw missingImage(image, 'docker pull succeeded but the image is not present');
    }
    const replaced =
      before !== null && before.id !== after.id
        ? `docker pull replaced image ${image}: ${before.id} is now ${after.id}; the Kiro CLI inside may have changed.`
        : null;
    return { id: after.id, notice: replaced };
  }
  if (after === null) {
    throw missingImage(image, `the pull failed: ${outcome.reason}`);
  }
  return {
    id: after.id,
    notice: `The refresh of image ${image} failed (${outcome.reason}); this start uses the local image ${after.id}, created ${after.created}.`,
  };
}

/** True for a reference pinned by digest, which is never pulled. */
export function isDigestPinned(image: string): boolean {
  return image.includes('@sha256:');
}

type PullOutcome = { readonly ok: true } | { readonly ok: false; readonly reason: string };

/** The pulls running in this server process, by state directory and reference. */
const running = new Map<string, Promise<PullOutcome>>();

/**
 * Pulls `image` once for every start of this process that needs it now:
 * a start that comes while the pull runs gets its outcome. The record is
 * read again first, so a start that read it just before another pull ended
 * pulls nothing (a recent failure is that failure's outcome); an `absent`
 * image is pulled whatever success the record holds.
 */
function sharedPull(
  context: ImageCheckContext,
  image: string,
  docker: ImageDocker,
  now: () => number,
  windowMs: number,
  absent: boolean,
): Promise<PullOutcome> {
  const key = `${context.stateDir}\u0000${image}`;
  const current = running.get(key);
  if (current !== undefined) {
    return current;
  }
  const pull = (async (): Promise<PullOutcome> => {
    const record = await readPullRecord(context.stateDir, image);
    if (!absent && pulledWithin(record, now(), windowMs)) {
      return { ok: true };
    }
    const failed = failedWithin(record, now());
    if (failed !== null) {
      return { ok: false, reason: failed.failure ?? 'no reason recorded' };
    }
    try {
      await docker.pull(image, { timeoutMs: IMAGE_PULL_TIMEOUT_MS, signal: context.signal });
    } catch (error) {
      const reason = shortReason(error);
      // A pull the shutdown ended did not fail: the next start tries again.
      if (context.signal?.aborted !== true) {
        await writePullRecord(context.stateDir, {
          reference: image,
          pulledAt: record?.pulledAt ?? null,
          failedAt: isoNow(now),
          failure: reason,
        });
      }
      return { ok: false, reason };
    }
    await writePullRecord(context.stateDir, { reference: image, pulledAt: isoNow(now), failedAt: null, failure: null });
    return { ok: true };
  })();
  running.set(key, pull);
  void pull.finally(() => running.delete(key)).catch(() => {});
  return pull;
}

function pulledWithin(record: PullRecord | null, now: number, windowMs: number): boolean {
  const at = timeOf(record?.pulledAt ?? null);
  return at !== null && at <= now && now - at < windowMs;
}

/** The record when its failure is less than an hour old, else null. */
function failedWithin(record: PullRecord | null, now: number): PullRecord | null {
  const at = timeOf(record?.failedAt ?? null);
  return at !== null && at <= now && now - at < PULL_RETRY_AFTER_MS ? record : null;
}

function timeOf(iso: string | null): number | null {
  if (iso === null) {
    return null;
  }
  const time = Date.parse(iso);
  return Number.isFinite(time) ? time : null;
}

function isoNow(now: () => number): string {
  return new Date(now()).toISOString();
}

/** The record file of a reference: a hash of it, so any reference is one safe name. */
export function pullRecordPath(stateDir: string, image: string): string {
  const name = createHash('sha256').update(image).digest('hex').slice(0, 32);
  return join(stateDir, PULL_RECORDS_DIR, `${name}.json`);
}

/** The record of a reference; null when it is missing, unreadable or not this reference's. */
export async function readPullRecord(stateDir: string, image: string): Promise<PullRecord | null> {
  let value: unknown;
  try {
    value = await readJsonIfExists(pullRecordPath(stateDir, image));
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  const { reference, pulledAt, failedAt, failure } = value as Record<string, unknown>;
  const nullableString = (field: unknown): field is string | null => field === null || typeof field === 'string';
  if (reference !== image || !nullableString(pulledAt) || !nullableString(failedAt) || !nullableString(failure)) {
    return null;
  }
  return { reference, pulledAt, failedAt, failure };
}

/**
 * Writes the record of a reference atomically. A record that cannot be
 * written is left as it was: the next start then pulls again, which is all
 * a lost record costs.
 */
async function writePullRecord(stateDir: string, record: PullRecord): Promise<void> {
  try {
    const path = pullRecordPath(stateDir, record.reference);
    await ensureDir(join(stateDir, PULL_RECORDS_DIR));
    await writeJsonAtomic(path, record);
  } catch {
    // See above.
  }
}

function missingImage(image: string, why: string | null): SidecarError {
  const base = `Docker image ${image} is not present locally. Pull it with: docker pull ${image}`;
  return new SidecarError('E_IMAGE_MISSING', why === null ? base : `${base} (${why})`);
}

/** An error's message on one line, cut to `REASON_MAX_CHARS`. */
function shortReason(error: unknown): string {
  const text = (error instanceof Error ? error.message : String(error)).replace(/\s+/g, ' ').trim();
  const reason = text === '' ? 'no error output' : text;
  return reason.length > REASON_MAX_CHARS ? `${reason.slice(0, REASON_MAX_CHARS)}...` : reason;
}

/** The docker operations through the Docker CLI, without `CLAUDE_*` variables. */
export function dockerCli(env: Environment): ImageDocker {
  const cliEnv = stripClaudeVariables(env);
  return {
    inspect: async (image) => {
      const result = await runDocker(['image', 'inspect', '--format', '{{.Id}} {{.Created}}', image], { env: cliEnv });
      const [id = '', ...created] = result.stdout.trim().split(' ');
      if (result.code === 0 && id !== '') {
        return { id, created: created.join(' ') };
      }
      if (NO_SUCH_IMAGE.test(result.stderr)) {
        return null;
      }
      throw new SidecarError('E_DOCKER', `docker image inspect ${image} failed: ${stderrSummary(result.stderr)}`);
    },
    pull: async (image, options) => {
      const result = await runDocker(['pull', '--quiet', image], {
        env: cliEnv,
        timeoutMs: options.timeoutMs,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
      if (result.code !== 0) {
        throw new Error(`docker pull exited with code ${result.code}: ${stderrSummary(result.stderr)}`);
      }
    },
  };
}
