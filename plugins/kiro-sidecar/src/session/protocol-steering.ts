/**
 * The protocol steering: the steering file that tells Kiro how to talk back
 * to the Claude session driving it through the plugin's own tools. Every
 * session gets it, with no setting to turn it off: in docker mode it is
 * written into the run's steering copies, which are mounted over the home's
 * `steering/`; in local mode into the home's `steering/` itself, the same
 * file for every run of the home.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { errorCode, writeTextAtomic } from '../store/files.ts';

/** The file's name in a steering directory. */
export const PROTOCOL_STEERING_FILE = 'sidecar-protocol.md';

/** The file's content: front matter that has Kiro apply it to every turn, then the text. */
export const PROTOCOL_STEERING = `---
inclusion: always
---

You are driven by another agent, a Claude session, through the kiro-sidecar plugin. You talk to it
with two tools, sidecar::send_message and sidecar::complete_task. They are deferred: load them with
tool_load before the first call.
- send_message {text}: tell the driver something, or ask it a question. It is delivered when your
  turn ends. To ask, call send_message with the question and then end your turn; the answer comes
  as your next prompt. Never end a turn waiting for an answer without calling send_message.
- complete_task {result}: call it once, when the whole task you were given is finished, with a
  short result; put a long report in a file and name the file in the result. Then end your turn:
  the session ends after it. Do not call send_message after complete_task.
`;

/**
 * Writes the protocol steering into the steering directory `dir`, unless
 * the file there already holds exactly this content. The new content goes to
 * a temp file whose name does not end in `.md`, so Kiro never takes it for
 * steering, and is renamed over the file, so a Kiro reading the directory
 * meanwhile sees the old file or the new one, never a part.
 */
export async function writeProtocolSteering(dir: string): Promise<void> {
  const path = join(dir, PROTOCOL_STEERING_FILE);
  let current: string | undefined;
  try {
    current = await readFile(path, 'utf8');
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') {
      throw error;
    }
  }
  if (current !== PROTOCOL_STEERING) {
    await writeTextAtomic(path, PROTOCOL_STEERING);
  }
}
