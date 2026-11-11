/**
 * Errors raised by the ACP client. Errors the agent returns over JSON-RPC are
 * passed through as the SDK's `RequestError`.
 */
import type { ProcessExit } from './process.ts';

export type AcpClientErrorCode =
  /** The connection is dead; every pending and later request fails with this. */
  | 'closed'
  /** A step did not finish within its timeout. */
  | 'timeout'
  /** The caller's AbortSignal fired. */
  | 'aborted'
  /** `setConfig` named an option or value the agent does not offer. */
  | 'invalid_config'
  /** The agent answered with something the client cannot use. */
  | 'protocol'
  /** Kiro reported that organization MCP settings filtered out the MCP server a wait was for. */
  | 'mcp_filtered';

/** Why the connection is dead. */
export type CloseReason =
  /** The agent process ended. */
  | 'exited'
  /** The agent's stdout ended while the process was still running. */
  | 'stream_closed'
  /** A message exceeded the size cap. */
  | 'message_too_large'
  /** Reading or writing the stream failed. */
  | 'stream_error'
  /** The client was terminated by its owner. */
  | 'terminated';

export interface AcpClientErrorDetails {
  readonly cause?: unknown;
  readonly closeReason?: CloseReason;
  readonly exit?: ProcessExit;
}

export class AcpClientError extends Error {
  readonly code: AcpClientErrorCode;
  readonly closeReason: CloseReason | undefined;
  readonly exit: ProcessExit | undefined;

  constructor(code: AcpClientErrorCode, message: string, details: AcpClientErrorDetails = {}) {
    super(message, details.cause === undefined ? undefined : { cause: details.cause });
    this.name = 'AcpClientError';
    this.code = code;
    this.closeReason = details.closeReason;
    this.exit = details.exit;
  }
}

/** The ACP error code "Authentication required", which Kiro also uses for other failures. */
export const AUTH_REQUIRED_CODE = -32000;

/**
 * Authentication, sign-in or login wording, as Kiro's sign-in errors use it
 * ("Authentication required", "Authentication token is invalid", "Sign in to
 * Kiro to send a prompt.", "you are not signed in", "You are not signed-in
 * to Kiro.", ...). "signed in" or "logged in" (with a space, hyphen or
 * underscore) used as an adjective right before "user" names someone rather
 * than saying who is not signed in, so it does not count: Kiro 3.2.0's
 * MemoryNotReadyError, also -32000, reads "This session's memories are not
 * ready, because the signed-in user is not known yet. Try again later."
 */
const AUTH_WORDING =
  /authenticat|\bsign[\s_-]?in\b|\bsigned[\s_-]?in\b(?![\s_-]+users?\b)|\blog[\s_-]?in\b|\blogged[\s_-]?in\b(?![\s_-]+users?\b)|\blogin/i;

/**
 * True for an error Kiro answered a request with that says it is not signed
 * in: ACP code -32000 and authentication, sign-in or login wording in its
 * message or data. Kiro answers other failures with -32000 too (a dropped
 * backend connection is "Your connection was interrupted"), so the code
 * alone is not enough.
 */
export function isAuthenticationError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const { code, message, data } = error as { code?: unknown; message?: unknown; data?: unknown };
  if (code !== AUTH_REQUIRED_CODE) {
    return false;
  }
  if (typeof message === 'string' && AUTH_WORDING.test(message)) {
    return true;
  }
  if (data === undefined || data === null) {
    return false;
  }
  let text: string | undefined;
  try {
    text = typeof data === 'string' ? data : JSON.stringify(data);
  } catch {
    return false;
  }
  return text !== undefined && AUTH_WORDING.test(text);
}
