/**
 * The session title the approval window shows: the title the user set with
 * /rename, else the one Claude Code generated, read from the transcript.
 */

import { readFileSync } from 'node:fs';

/**
 * The last `custom-title` record's `customTitle`, else the last `ai-title`
 * record's `aiTitle`, else undefined. Never throws: a missing or unreadable
 * transcript, or a corrupt line, only means no title.
 */
export function sessionTitle(transcriptPath: string | undefined): string | undefined {
  if (transcriptPath === undefined || transcriptPath === '') return undefined;
  try {
    const text = readFileSync(transcriptPath, 'utf8');
    let custom: string | undefined;
    let ai: string | undefined;
    for (const line of text.split('\n')) {
      // Only title records are parsed; the rest of the transcript is skipped unread.
      if (!line.includes('"custom-title"') && !line.includes('"ai-title"')) continue;
      let record: unknown;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      if (record === null || typeof record !== 'object') continue;
      const { type, customTitle, aiTitle } = record as Record<string, unknown>;
      if (type === 'custom-title' && typeof customTitle === 'string' && customTitle !== '') {
        custom = customTitle;
      } else if (type === 'ai-title' && typeof aiTitle === 'string' && aiTitle !== '') {
        ai = aiTitle;
      }
    }
    return custom ?? ai;
  } catch {
    return undefined;
  }
}
