/**
 * Zero-dependency Telegram Bot API client (long polling) for dsh-telegram-remote.
 * Uses global fetch (Node >= 22). No external services, no webhooks: the
 * harness polls api.telegram.org directly, so it works behind NAT / no
 * inbound ports.
 */

const API_BASE = "https://api.telegram.org";
const MAX_MESSAGE_LENGTH = 4096;

/** Escape text for Telegram HTML parse_mode. */
export function htmlEscape(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

/** Plain-text value with optional HTML tagging; safe when embedded in HTML mode. */
export function esc(value) {
  return htmlEscape(value ?? "");
}

export class TelegramBot {
  token;
  log;
  offset = 0;
  stopped = false;
  loop = null;
  pollAbort = null;
  lastPollAt = 0;
  me = null;
  seen = new Set();

  constructor(token, log = () => {}) {
    if (!token || typeof token !== "string" || !token.includes(":")) {
      throw new Error(`telegram-remote: invalid bot token (${typeof token})`);
    }
    this.token = token;
    this.log = log;
    // Called whenever the poll cursor advances, so callers can persist it.
    this.onOffset = null;
  }

  async call(method, params = {}, { timeoutMs = 90_000, signal } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    // Chain an external signal (e.g. the poll abort) so stop() can kill an
    // in-flight getUpdates immediately instead of waiting for its timeout.
    // The listener is removed on completion: the poll loop reuses ONE
    // controller per request, so without cleanup listeners would accumulate.
    const onAbort = () => controller.abort();
    if (signal) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
    try {
      const res = await fetch(`${API_BASE}/bot${this.token}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(params),
        signal: controller.signal,
      });
      if (!res.ok) {
        const text = (await res.text()).slice(0, 500);
        throw new Error(`telegram ${method}: HTTP ${res.status} ${text}`);
      }
      const data = await res.json();
      if (!data.ok) {
        const err = new Error(`telegram ${method}: ${data.description ?? "unknown error"}`);
        err.code = data.error_code;
        throw err;
      }
      return data.result;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }

  /** Verify the token and cache bot identity. */
  async getMe() {
    this.me = await this.call("getMe", {});
    return this.me;
  }

  /** Set the slash-command menu shown when the user types "/". */
  async setMyCommands(commands) {
    await this.call("setMyCommands", { commands });
  }

  /**
   * Send a text message, splitting into Telegram-sized chunks.
   * @returns {Promise<number[]>} message ids
   */
  async send(chatId, text, opts = {}) {
    const { parseMode = "HTML", replyMarkup, replyToMessageId } = opts;
    const chunks = splitMessage(String(text ?? ""));
    const ids = [];
    // Plain text needs no HTML mode: skip it to save a Telegram parse pass.
    const useHtml = parseMode === "HTML" && /[<&]/.test(String(text ?? ""));
    const base = {
      chat_id: chatId,
      disable_web_page_preview: true,
      ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
      ...(replyToMessageId ? { reply_to_message_id: replyToMessageId } : {}),
    };
    for (const chunk of chunks) {
      const payload = { ...base, text: chunk, ...(useHtml ? { parse_mode: "HTML" } : {}) };
      let result;
      try {
        result = await this.call("sendMessage", payload);
      } catch (error) {
        // Telegram returns HTTP 400 for bad HTML (the .code field isn't set
        // on the HTTP path), so match on the message text. Fall back to plain
        // text rather than losing the message.
        if (/400|parse entities|can't parse/i.test(String(error?.message ?? ""))) {
          result = await this.call("sendMessage", { ...base, text: chunk });
        } else {
          throw error;
        }
      }
      ids.push(result.message_id);
    }
    return ids;
  }

  /** Edit one of our own messages (used for live streaming of replies). */
  async editMessageText(chatId, messageId, text) {
    try {
      return await this.call("editMessageText", {
        chat_id: chatId,
        message_id: messageId,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: true,
      });
    } catch (error) {
      // Never lose a live edit to a parse error: retry as plain text.
      if (/400|parse entities|can't parse/i.test(String(error?.message ?? ""))) {
        return this.call("editMessageText", {
          chat_id: chatId,
          message_id: messageId,
          text,
          disable_web_page_preview: true,
        });
      }
      throw error;
    }
  }

  /** Delete one of our own messages. */
  async deleteMessage(chatId, messageId) {
    try {
      await this.call("deleteMessage", { chat_id: chatId, message_id: messageId });
    } catch {}
  }

  /** Resolve a file id to a downloadable path. */
  async getFile(fileId) {
    return this.call("getFile", { file_id: fileId });
  }

  /** Download a bot file (file_path from getFile) into a Buffer. */
  async downloadFile(filePath) {
    const res = await fetch(`${API_BASE}/file/bot${this.token}/${filePath}`);
    if (!res.ok) throw new Error("telegram downloadFile: HTTP " + res.status);
    return Buffer.from(await res.arrayBuffer());
  }

  /** Send a binary document (e.g. a session export zip). */
  async sendDocument(chatId, buffer, filename, caption) {
    const form = new FormData();
    form.append("chat_id", String(chatId));
    form.append("document", new Blob([buffer]), filename);
    if (caption) form.append("caption", caption);
    const res = await fetch(`${API_BASE}/bot${this.token}/sendDocument`, { method: "POST", body: form });
    const data = await res.json();
    if (!data.ok) throw new Error("telegram sendDocument: " + (data.description ?? "HTTP " + res.status));
    return data.result;
  }

  async answerCallbackQuery(callbackQueryId, text) {
    try {
      await this.call("answerCallbackQuery", {
        callback_query_id: callbackQueryId,
        ...(text ? { text: String(text).slice(0, 200) } : {}),
      });
    } catch (error) {
      this.log(`answerCallbackQuery failed: ${error.message}`);
    }
  }

  /**
   * Start the long-polling loop. Callback receives { type: "message"|"callback_query", update }.
   */
  start(onUpdate) {
    // A stopped bot stays stopped forever: HMR reloads stop the previous
    // poller, and any late async callbacks (getMe / setupDispatch) must NOT
    // revive it — two getUpdates loops would fight for the token (409s).
    if (this.loop || this.stopped) return;
    this.loop = this.#run(onUpdate);
    return this.loop;
  }

  async #run(onUpdate) {
    let consecutiveErrors = 0;
    while (!this.stopped) {
      const controller = new AbortController();
      this.pollAbort = controller;
      try {
        const timeout = 50;
        // Reuse the loop controller directly as the abort signal — no extra
        // listener chaining, and stop() aborts the in-flight request at once.
        const result = await this.call(
          "getUpdates",
          {
            timeout,
            offset: this.offset,
            allowed_updates: ["message", "callback_query"],
          },
          { timeoutMs: (timeout + 15) * 1000, signal: controller.signal },
        );
        consecutiveErrors = 0;
        this.lastPollAt = Date.now();
        for (const update of result ?? []) {
          if (typeof update.update_id !== "number") continue;
          const next = update.update_id + 1;
          if (next > this.offset) {
            this.offset = next;
            try { this.onOffset?.(this.offset); } catch {}
          }
          if (this.seen.has(update.update_id)) continue;
          this.seen.add(update.update_id);
          if (this.seen.size > 10_000) {
            const keep = [...this.seen].slice(-5_000);
            this.seen = new Set(keep);
          }
          try {
            await onUpdate(update);
          } catch (error) {
            this.log(`update ${update.update_id} handler failed: ${error.stack ?? error.message}`);
          }
        }
      } catch (error) {
        if (this.stopped) break;
        consecutiveErrors += 1;
        const code = error?.code;
        if (code === 401) {
          this.log(`telegram-remote: FATAL — token rejected (401 Unauthorized)`);
          await sleep(30_000);
        } else if (code === 409) {
          this.log(`telegram-remote: getUpdates conflict — another poller is active for this bot`);
          await sleep(10_000);
        } else {
          this.log(`telegram-remote: getUpdates error: ${error.message}`);
          await sleep(Math.min(2_000 * consecutiveErrors, 30_000));
        }
      } finally {
        this.pollAbort = null;
      }
    }
    this.loop = null;
  }

  stop() {
    this.stopped = true;
    this.pollAbort?.abort();
  }
}

/** Split long text into Telegram-safe chunks on line boundaries. */
export function splitMessage(text) {
  if (text.length <= MAX_MESSAGE_LENGTH) return [text];
  const chunks = [];
  let rest = text;
  while (rest.length > MAX_MESSAGE_LENGTH) {
    let cut = rest.lastIndexOf("\n", MAX_MESSAGE_LENGTH);
    if (cut <= 0) cut = MAX_MESSAGE_LENGTH;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest.length > 0) chunks.push(rest);
  return chunks;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
