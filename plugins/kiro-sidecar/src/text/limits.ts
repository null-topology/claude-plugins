/**
 * Size limits of the text pipeline. Byte limits apply to the UTF-8 bytes on
 * disk; character limits count UTF-16 code units, as JS strings do.
 */

export const KiB = 1024;
export const MiB = 1024 * KiB;

/** `acp.jsonl` stops at this size; lifecycle lines are still written past it. */
export const ACP_LOG_CAP_BYTES = 20 * MiB;
/** `stderr.log` stops at this size. */
export const STDERR_LOG_CAP_BYTES = 5 * MiB;
/** `turns/<n>.md` stops at this size and is marked truncated. */
export const TURN_TEXT_CAP_BYTES = 2 * MiB;
/**
 * With `debug_acp`, every string value of a logged frame and every `content`
 * field whose JSON form is over this size is cut to it.
 */
export const DEBUG_FIELD_CAP_BYTES = 4 * KiB;

/** Previews of `final` in tool replies are cut to this many characters. */
export const REPLY_PREVIEW_CHARS = 20_000;
/** Default and maximum `limit` of a page of turn text. */
export const PAGE_LIMIT_DEFAULT = 20_000;
export const PAGE_LIMIT_MAX = 40_000;
/** `firstPromptPreview` keeps this many characters of the first prompt. */
export const PROMPT_PREVIEW_CHARS = 200;
/**
 * A `prompt_file` may hold at most this many bytes. The value is this
 * plugin's choice. It matches the `ndJsonStream` default, but that default
 * caps only the messages the sidecar reads, not the ones it writes. In local
 * mode the file's content travels inside one `session/prompt` message, which
 * JSON escaping can make several times larger than the file. Whether Kiro
 * accepts a message that large is up to Kiro's own reader, whose limit is not
 * known here. In docker mode Kiro reads the mounted copy instead.
 */
export const PROMPT_FILE_MAX_BYTES = 32 * MiB;
/** `stderrTail` returns this many lines. */
export const STDERR_TAIL_LINES = 20;
/** `stderrTail` reads at most this many bytes from the end of the file. */
export const STDERR_TAIL_MAX_BYTES = 64 * KiB;

/** A Kiro token shorter than this is refused. */
export const MIN_KIRO_TOKEN_CHARS = 16;
/** A session label is 1 to this many characters. */
export const LABEL_MAX_CHARS = 40;
/**
 * A wake header value or a tool title (`lastTool`) is cut to this many
 * characters, before neutralising, keeping its start (4.4, 4.6).
 */
export const FIELD_KEPT_CHARS = 500;

/**
 * What the plugin keeps of Kiro's calls of its own tools (4.4, 4.11): a
 * `send_message` text is cut to `MESSAGE_KEPT_CHARS`, a turn keeps its latest
 * messages within `MESSAGES_KEPT_TOTAL_CHARS` in total, and a `complete_task`
 * result is cut to `RESULT_KEPT_CHARS`. The tool server's replies name the
 * per-call bounds.
 */
export const MESSAGE_KEPT_CHARS = 4_000;
export const MESSAGES_KEPT_TOTAL_CHARS = 12_000;
export const RESULT_KEPT_CHARS = 20_000;

/**
 * A failed turn's `error` and `stderrTail` in a reply, measured as shown: the
 * error keeps its start, the stderr tail its end; the turn file keeps them as
 * recorded (4.4).
 */
export const REPLY_ERROR_CHARS = 2_000;
export const REPLY_STDERR_TAIL_CHARS = 4_000;

/** Mode of every file this pipeline creates. */
export const PRIVATE_FILE_MODE = 0o600;

/** Renders a byte count for a marker: whole MiB or KiB when exact, else bytes. */
export function formatBytes(bytes: number): string {
  if (bytes > 0 && bytes % MiB === 0) {
    return `${bytes / MiB} MiB`;
  }
  if (bytes > 0 && bytes % KiB === 0) {
    return `${bytes / KiB} KiB`;
  }
  return `${bytes} bytes`;
}
