/**
 * Tiny UI kit: consistent, pretty Telegram message composition.
 * All helpers return HTML-safe strings (callers escape user data).
 */

/** Soft horizontal divider. */
export const DIVIDER = "─────── ⋆⋅☆⋅⋆ ───────";
/** Slim divider for tight layouts. */
export const SLIM = "────────────";

/** Section heading with a leading emoji. */
export function heading(emoji, title) {
  return "<b>" + emoji + " " + title + "</b>";
}

/** Hero header for welcome/start pages. */
export function hero(title, subtitle) {
  return "✨ <b>" + title + "</b>" + (subtitle ? "\n<i>" + subtitle + "</i>" : "");
}

/** One feature/fact row: emoji + label + detail. */
export function row(emoji, label, detail) {
  return emoji + " <b>" + label + "</b>" + (detail ? " — " + detail : "");
}

/** Bullet line with an optional muted hint. */
export function bullet(text, hint) {
  return "• " + text + (hint ? " <small>(" + hint + ")</small>" : "");
}

/** Command line: /cmd + short hint, monospace. */
export function command(cmd, hint) {
  return "<code>" + cmd + "</code>" + (hint ? " — " + hint : "");
}

/** Muted small print. */
export function small(text) {
  return "<small>" + text + "</small>";
}

/** Status chip: colored dot + word. */
export function chip(dot, word) {
  return "<b>" + dot + "</b> " + word;
}

/** Numbered list item with title + meta line. */
export function numbered(index, title, meta) {
  return (index + 1) + ". <b>" + title + "</b>" + (meta ? "\n   <small>" + meta + "</small>" : "");
}

/** Keyboard: rows of buttons. */
export function inlineKeyboard(rows) {
  return { inline_keyboard: rows.map((rowButtons) => rowButtons.map((b) => ({
    text: b.text,
    callback_data: b.data ?? b.text,
  }))) };
}
