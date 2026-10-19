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
  | 'protocol';

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
