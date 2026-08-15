/**
 * PluginState for dsh-telegram-remote: per-chat state, logging, push queue,
 * prompt-echo suppression.
 */

import { appendFileSync, renameSync, statSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dshHome, nowIso, sleep, shortId } from "./util.js";

export class PluginState {
  ctx;
  config;
  bot;
  logPath;
  statePath;
  chats = new Map();
  recentPrompts = new Map();
  jobStatuses = new Map();
  pendingSends = new Map();
  pendingOpts = new Map();
  sendingChats = new Set();
  restartScriptPath;

  constructor(ctx, config, bot) {
    this.ctx = ctx;
    // Apply code-side defaults (the plugin deliberately ships no Config
    // schema, so loader entries may omit any key).
    this.config = {
      botToken: "",
      tokenEnv: "TELEGRAM_BOT_TOKEN",
      tokenFile: "",
      allowedUserIds: [],
      ownerChatId: undefined,
      workspaceRoot: process.cwd(),
      defaultSessionId: "",
      allowEval: true,
      notifyOnStartup: true,
      stateFile: "",
      logFile: "",
      pollTimeoutSec: 50,
      maxOutputBytes: 120000,
      ...(config ?? {}),
    };
    this.bot = bot;
    this.logPath = config.logFile || join(dshHome(), "telegram-remote.log");
    this.statePath = config.stateFile || join(dshHome(), "telegram-remote-state.json");
    this.restartScriptPath = join(dshHome(), "telegram-remote-restart.ps1");
    this.loadState();
  }

  log(message) {
    const line = "[" + nowIso() + "] " + message;
    try {
      appendFileSync(this.logPath, line + "\n", "utf8");
      let size = 0;
      try { size = statSync(this.logPath).size; } catch {}
      if (size > 2 * 1024 * 1024) {
        try { renameSync(this.logPath, this.logPath + ".1"); } catch {}
      }
    } catch {}
    try { this.ctx.logger.info("[telegram-remote] " + message); } catch {}
  }

  loadState() {
    try {
      const raw = JSON.parse(readFileSync(this.statePath, "utf8"));
      for (const [chatId, value] of Object.entries(raw.chats ?? {})) {
        this.chats.set(Number(chatId), {
          sessionId: value.sessionId ?? "",
          notify: value.notify ?? "off",
        });
      }
    } catch {}
  }

  saveState() {
    const payload = {
      chats: Object.fromEntries([...this.chats.entries()].map(([id, v]) => [String(id), v])),
    };
    try {
      writeFileSync(this.statePath, JSON.stringify(payload, null, 2), "utf8");
    } catch (error) {
      this.log("state save failed: " + error.message);
    }
  }

  chatState(chatId) {
    let state = this.chats.get(chatId);
    if (!state) {
      state = { sessionId: this.config.defaultSessionId || "", notify: "session", sessionIds: [], lastListAt: 0 };
      this.chats.set(chatId, state);
    }
    return state;
  }

  isAuthorized(userId) {
    if (this.config.ownerChatId != null && userId === this.config.ownerChatId) return true;
    return Array.isArray(this.config.allowedUserIds) && this.config.allowedUserIds.includes(userId);
  }

  async listSessions() {
    const { callApi } = await import("./util.js");
    try {
      const result = await callApi(this.ctx, "sessions", "list", {});
      const items = Array.isArray(result) ? result : (result?.items ?? []);
      if (items.length > 0) return items;
    } catch {}
    // Fallback for profiles without the web api-proxy: read the live/corpus
    // registries directly.
    const items = [];
    const sessions = this.ctx.get("sessions");
    const sessionQuery = this.ctx.get("sessionQuery");
    const seen = new Set();
    if (sessions) {
      for (const session of sessions.list()) {
        seen.add(session.id);
        items.push({
          sessionId: session.id,
          updatedAt: session.header?.updatedAt ?? session.header?.createdAt ?? 0,
          running: this.ctx.get("agents")?.get(session.id)?.status === "running",
          blank: !session.events.some((event) => event.type === "turn/start"),
          cwd: session.header?.cwd,
        });
      }
    }
    if (sessionQuery) {
      try {
        for (const record of await sessionQuery.listSessions()) {
          if (seen.has(record.header.id)) continue;
          items.push({
            sessionId: record.header.id,
            updatedAt: record.header.createdAt ?? 0,
            running: false,
            blank: true,
            cwd: record.header.cwd,
          });
        }
      } catch {}
    }
    items.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
    return items;
  }

  /** Resolve a session id argument: full id, prefix, "last", or the chat's active session. */
  async resolveSessionId(chatId, arg) {
    const wanted = String(arg ?? "").trim();
    let sessionId = wanted;
    if (!sessionId) {
      sessionId = this.chatState(chatId).sessionId;
      if (!sessionId) return null;
      return sessionId;
    }
    if (sessionId === "last") {
      const summaries = await this.listSessions();
      if (!summaries || summaries.length === 0) return null;
      return summaries[0].sessionId;
    }
    const summaries = await this.listSessions();
    if (summaries) {
      const match = summaries.find((item) => item.sessionId === sessionId);
      const prefix = summaries.find((item) => item.sessionId.startsWith(sessionId));
      return (match ?? prefix ?? null)?.sessionId ?? sessionId;
    }
    return sessionId;
  }

  notePrompt(sessionId, text) {
    const list = this.recentPrompts.get(sessionId) ?? [];
    list.push({ text: String(text).trim().slice(0, 200), at: Date.now() });
    while (list.length > 20) list.shift();
    this.recentPrompts.set(sessionId, list);
  }

  isRecentPrompt(sessionId, text) {
    const list = this.recentPrompts.get(sessionId) ?? [];
    const needle = String(text).trim().slice(0, 200);
    const now = Date.now();
    return list.some((entry) => now - entry.at < 90_000 && entry.text === needle);
  }

  async #drain(chatId) {
    if (this.sendingChats.has(chatId)) return;
    this.sendingChats.add(chatId);
    try {
      for (;;) {
        const text = this.pendingSends.get(chatId);
        if (text === undefined) break;
        this.pendingSends.delete(chatId);
        const opts = this.pendingOpts.get(chatId) ?? {};
        this.pendingOpts.delete(chatId);
        try {
          await this.bot.send(chatId, text, opts.replyTo ? { replyToMessageId: opts.replyTo } : {});
        } catch (error) {
          this.log("push to chat " + chatId + " failed: " + error.message);
          const again = this.pendingSends.get(chatId);
          this.pendingSends.set(chatId, (again ? again + "\n\n" : "") + text);
          this.pendingOpts.set(chatId, opts);
          await sleep(5000);
          break;
        }
      }
    } finally {
      this.sendingChats.delete(chatId);
    }
  }

  /**
   * Push a session event to interested chats.
   * @param category - "reply" (assistant replies, turn ends: delivered to
   *   every chat with notify session/all) or "detail" (tool calls, web-side
   *   user messages, errors: only notify=all chats — too noisy otherwise).
   */
  notifySession(sessionId, text, category = "reply") {
    for (const [chatId, state] of this.chats) {
      if (state.notify === "off") continue;
      if (state.notify === "session" && sessionId !== state.sessionId) continue;
      if (category === "detail" && state.notify !== "all") continue;
      // The active session reads as a plain conversation — no session id
      // prefix. Other sessions (notify=all) get a small label to distinguish.
      const body = sessionId === state.sessionId
        ? text
        : "<b>" + shortId(sessionId) + "</b>\n" + text;
      this.push(chatId, body, { replyTo: state.lastUserMessageId });
    }
  }

  /** Coalescing push sender: one in-flight send per chat, pending text merged. */
  push(chatId, text, opts = {}) {
    const existing = this.pendingSends.get(chatId);
    if (existing !== undefined) {
      this.pendingSends.set(chatId, existing + "\n\n" + text);
      return;
    }
    this.pendingSends.set(chatId, text);
    this.pendingOpts.set(chatId, opts);
    void this.#drain(chatId);
  }

  notifyAll(text) {
    for (const chatId of this.chats.keys()) this.push(chatId, text);
  }
}
