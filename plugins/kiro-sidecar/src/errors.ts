/**
 * The errors a tool reports. A tool reply for one of them is an MCP error
 * result whose text is `<code> <message>`. The message is shown to the caller
 * as is, so it never contains a secret.
 */

export type SidecarErrorCode =
  /** A bad argument or value; the message names the field (`InvalidInputError`). */
  | 'E_INVALID'
  /** No such session in this home, or no such turn. */
  | 'E_NOT_FOUND'
  /** The session is starting or running a turn, or its mutex is held. */
  | 'E_BUSY'
  /** The session belongs to another live Claude process. */
  | 'E_OWNED'
  /** The turn did not end within 10 s of `session/cancel`. */
  | 'E_CANCEL_TIMEOUT'
  /** The Docker CLI or daemon failed, or the daemon setup is not supported. */
  | 'E_DOCKER'
  /** The Kiro image is not present locally; the message gives the pull command. */
  | 'E_IMAGE_MISSING'
  /** A `start` or `resume` step failed or timed out; the message has the stderr tail. */
  | `E_STEP_${string}`
  /** A defect in the plugin itself. */
  | 'E_INTERNAL';

export class SidecarError extends Error {
  readonly code: SidecarErrorCode;

  constructor(code: SidecarErrorCode, message: string) {
    super(message);
    this.name = 'SidecarError';
    this.code = code;
  }
}
