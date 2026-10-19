/**
 * The per-session mutex (4.2): `send`, `cancel`, `stop` and `resume` of one
 * session never overlap. A call that arrives while another holds the
 * session's mutex fails with `E_BUSY` at once instead of waiting.
 */

import { SidecarError } from '../errors.ts';

export class SessionMutex {
  readonly #held = new Map<string, string>();

  /** The call that holds the mutex of `launchId`, if any. */
  holder(launchId: string): string | undefined {
    return this.#held.get(launchId);
  }

  /** Runs `body` holding the mutex of `launchId`; `E_BUSY` when it is held. */
  async run<T>(launchId: string, call: string, body: () => Promise<T>): Promise<T> {
    const holder = this.#held.get(launchId);
    if (holder !== undefined) {
      throw new SidecarError('E_BUSY', `Session ${launchId} is busy with another ${holder} call; try again later`);
    }
    this.#held.set(launchId, call);
    try {
      return await body();
    } finally {
      this.#held.delete(launchId);
    }
  }
}
