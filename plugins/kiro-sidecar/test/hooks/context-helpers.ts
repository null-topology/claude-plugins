/** The new conversation's session id in the SessionStart inputs below. */
export const NEW_SESSION_ID = '4e1f9c2b-7a3d-4b6e-8c5f-1a2b3c4d5e6f';

/** A SessionStart input as Claude Code passes it on stdin. */
export function sessionStart(
  source = 'clear',
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    session_id: NEW_SESSION_ID,
    transcript_path: `/home/user/.claude/projects/-work-app/${NEW_SESSION_ID}.jsonl`,
    cwd: '/work/app',
    hook_event_name: 'SessionStart',
    source,
    ...overrides,
  };
}
