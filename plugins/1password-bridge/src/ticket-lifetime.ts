/**
 * How long a ticket can be redeemed after it is issued. The broker expires
 * tickets by it (`src/broker/tickets.ts`), and the board keeps a foreground
 * entry live at least this long (`src/board.ts`). It sits apart from both so
 * the hook bundle can use it without pulling in broker modules.
 */
export const TICKET_TTL_MS = 10 * 60 * 1000;
