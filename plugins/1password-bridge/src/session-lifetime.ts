/**
 * How long a session lives unheard of. The broker forgets a session's tickets
 * and masks after SESSION_FORGET_MS without a request for it, found by a scan
 * every FORGET_SCAN_MS (`src/broker/service.ts`); SessionStart sweeps a
 * session's directory, its `masked` marker included, after SWEEP_AGE_MS
 * without a hook run (`src/hooks/session-start.ts`). The two run on different
 * clocks. While the broker hears only hook-driven requests and redeems within
 * a ticket's lifetime, it forgets at most SESSION_FORGET_MS + TICKET_TTL_MS +
 * FORGET_SCAN_MS (7 d 20 min) after the last hook. The sweep waits an hour
 * past SESSION_FORGET_MS, longer than that, so the broker forgets first and no
 * marker goes while the broker still masks. A known limit: the broker notes a
 * redeem before checking it, so a refused redeem later than that (an expired
 * ticket used by a background job) keeps the broker's clock ahead, and the
 * broker may then forget after the sweep. This module sits apart from both so
 * the hook bundle can use it without pulling in broker modules.
 */
export const SESSION_FORGET_MS = 7 * 24 * 60 * 60 * 1000;

/** How often the broker looks for sessions to forget, at most. */
export const FORGET_SCAN_MS = 10 * 60 * 1000;

/** A session not seen for longer than this is swept. */
export const SWEEP_AGE_MS = SESSION_FORGET_MS + 60 * 60 * 1000;
