/**
 * dsh-telegram-remote — full remote control and state visibility for the
 * DeepSeek Harness from Telegram mobile. Runs inside the dsh process as a
 * Cordis host plugin; talks to the Telegram Bot API by long polling.
 */

import { appendFileSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { TelegramBot, esc } from "./bot.js";
import { dshHome, nowIso, truncate, shortId, contentText, markdownToHtml, callApi } from "./util.js";
import { PluginState } from "./state.js";
import { COMMAND_TABLE, KEYBOARD, WELCOME, COMMANDS_MENU, cmdMsg } from "./commands.js";
import { setupStreaming, handleInteractiveCallback } from "./stream.js";

export const name = "telegram-remote";

// No Config schema on purpose: the plugin must stay dependency-free (it is
// loaded through a pnpm link whose own node_modules are not installed), so
// all configuration arrives as plain values in the loader entry's config
// object and defaults are applied in code.

export const inject = ["timer", "sessions", "agents", "jobs", "fs", "sessionQuery", "typertGateway", "goals", "settings", "shell"];

/* ── event forwarding (push notifications) ── */


/* ── background job + session lifecycle notifications ── */

function setupJobsForwarding(state) {
  const ctx = state.ctx;
  const jobs = ctx.get("jobs");
  if (jobs && typeof jobs.onJobsChanged === "function") {
    try {
      jobs.onJobsChanged((owner) => {
        try {
          const snapshots = owner ? jobs.list(owner) : [];
          for (const job of snapshots) {
            const previous = state.jobStatuses.get(job.id);
            if (previous !== undefined && previous !== job.status) {
              const icons = { running: "🏃", stopping: "⏳", completed: "✅", killed: "⏹", failed: "❌" };
              const ownerName = owner?.session?.id ? shortId(owner.session.id) : "?";
              let line = "<b>job " + esc(job.id) + "</b> [" + esc(job.label) + "] " + (icons[job.status] ?? job.status);
              if (job.detail) line += " — " + esc(job.detail);
              line += " (owner " + ownerName + ")";
              state.notifyAll(line);
            }
            state.noteJobStatus(job.id, job.status);
          }
        } catch (error) {
          state.log("jobs changed forward failed: " + error.message);
        }
      });
    } catch (error) {
      state.log("jobs.onJobsChanged failed: " + error.message);
    }
  }
  ctx.on("session/created", (session) => {
    try { state.notifyAll("🆕 session created: <code>" + (session?.id ?? "?") + "</code>"); } catch {}
  });
  ctx.on("session/disposed", (session) => {
    try { state.notifyAll("🗑 session disposed: <code>" + (session?.id ?? "?") + "</code>"); } catch {}
  });
}


/* ── update dispatch ── */

async function handleText(state, chatId, userId, text, messageId) {
  const trimmed = String(text ?? "").trim();
  if (!trimmed) return;
  const tokens = trimmed.split(/\s+/);
  const first = tokens[0].toLowerCase();
  const command = first.startsWith("/") ? first.slice(1) : first;
  const handler = COMMAND_TABLE[command];
  const args = tokens.slice(1);
  const rest = trimmed.slice(first.length).trim();

  const authorized = userId != null && state.isAuthorized(userId);
  if (!authorized) {
    try {
      await state.bot.send(
        chatId,
        "⛔ <b>Unauthorized</b>\nYour telegram user id: <code>" + (userId ?? "unknown") + "</code>\nAdd it to <code>allowedUserIds</code> (or set <code>ownerChatId</code>) in the plugin config.",
      );
    } catch {}
    state.log("unauthorized contact: user=" + userId + " chat=" + chatId + " text=" + truncate(trimmed, 80));
    return;
  }

  if (messageId != null) state.chatState(chatId).lastUserMessageId = messageId;

  const runtime = {
    ctx: state.ctx,
    state,
    bot: state.bot,
    chatId,
    userId,
    authorized,
    args,
    rest,
    text: trimmed,
  };

  // ── dispatch: slash commands, friendly shortcuts, or a chat message ──
  let fn = null;
  if (trimmed.startsWith("/")) {
    fn = handler ?? null;
    if (!fn) {
      try {
        await state.bot.send(chatId, "Hmm, I don't know <code>" + esc(first) + "</code> — /help shows what I can do 🙂");
      } catch {}
      return;
    }
  } else {
    const lower = trimmed.toLowerCase().replace(/[.!?]+$/, "");
    if (lower === "help" || lower === "what can you do") fn = COMMAND_TABLE.help;
    else if (lower === "status" || lower === "what's up" || lower === "ping") fn = COMMAND_TABLE.status;
    else if (lower === "models" || lower === "model" || lower === "change model" || lower === "which models") fn = COMMAND_TABLE.models;
    else if (lower === "chats" || lower === "my chats" || lower === "sessions" || lower === "chat list") fn = COMMAND_TABLE.chats;
    else if (lower === "new chat" || lower === "start chat" || lower === "new") fn = COMMAND_TABLE.new;
    else if (lower === "stop" || lower === "stop that" || lower === "cancel") fn = COMMAND_TABLE.stop;
    else if (lower === "hi" || lower === "hello" || lower === "hey" || lower === "yo") {
      // Greeting: welcome them, don't waste an agent turn.
      const cs = state.chatState(chatId);
      if (!cs.sessionId) {
        try { await state.bot.send(chatId, WELCOME, { replyMarkup: KEYBOARD }); } catch {}
        return;
      }
      fn = cmdMsg;
    } else if (/^\d+$/.test(lower) && state.chatState(chatId).sessionIds?.length > 0 && Date.now() - (state.chatState(chatId).lastListAt ?? 0) < 10 * 60_000) {
      // A bare number right after /chats opens that chat.
      fn = COMMAND_TABLE.open;
      runtime.args = [lower];
      runtime.rest = lower;
    } else {
      fn = cmdMsg;
    }
  }
  try {
    const reply = await fn(runtime);
    if (reply != null) {
      const isObj = typeof reply === "object" && reply !== null && !Array.isArray(reply);
      const msg = isObj ? reply.text : reply;
      const kb = isObj && reply.keyboard ? reply.keyboard : KEYBOARD;
      if (msg != null && String(msg).trim().length > 0) {
        await state.bot.send(chatId, msg, { replyMarkup: kb });
      }
    }
    state.log("cmd " + command + " by " + userId + " (chat " + chatId + ")");
  } catch (error) {
    state.log("cmd " + command + " failed: " + (error.stack ?? error.message));
    let friendly = String(error.message ?? error).slice(0, 200);
    // Translate common errors into plain language.
    if (/session.*not found|not found.*session/i.test(friendly)) {
      friendly = "That chat isn't available right now — try /chats and pick one.";
    } else if (/no active session|no api surface/i.test(friendly)) {
      friendly = "No chat is open yet — tap 💬 New chat and say hi!";
    } else if (/unauthorized|not authorized/i.test(friendly)) {
      friendly = "You're not allowed to do that.";
    } else if (/agent-busy|busy/i.test(friendly)) {
      friendly = "The AI is busy right now — try again in a moment.";
    }
    try {
      await state.bot.send(chatId, "⚠️ " + friendly + "\n<i>If you keep seeing this, /help or ask the owner.</i>");
    } catch {}
  }
}

/* ── apply ── */

export function apply(ctx, config) {
  let state = null;
  try {
    const token = resolveToken(config);
    if (!token) {
      logBoot(ctx, "no bot token — set config.botToken, tokenEnv, or tokenFile");
      return () => {};
    }
    const bot = new TelegramBot(token, (msg) => {
      try { appendFileSync(join(dshHome(), "telegram-remote.log"), "[" + nowIso() + "] " + msg + "\n", "utf8"); } catch {}
    });
    state = new PluginState(ctx, config, bot);
    bot.onOffset = () => { try { state.saveState(); } catch {} };
    state.loadState();
    // Newest-state pointer for the process-wide watchdog (survives reloads).
    globalThis.__dshTgState = state;

    // ── live-reload safety: stop every earlier poller ──
    // HMR hot-reloads this plugin by re-running apply in the SAME process.
    // globalThis survives module re-imports, so a stale poller from the old
    // module instance is still reachable here — stop it before starting a new
    // one, otherwise Telegram returns 409 conflicts forever (two getUpdates
    // loops). This also covers reloads where cordis never runs our dispose.
    const botRegistry = (globalThis.__dshTelegramBots ??= []);
    for (const older of botRegistry) {
      if (older === bot) continue;
      try {
        // Carry the polling cursor forward: without this, the reloaded bot
        // starts at offset 0 with an empty seen-set and Telegram RE-DELIVERS
        // recent updates — which is why old messages you sent kept appearing
        // again after every hot reload.
        if (older.offset > bot.offset) bot.offset = older.offset;
        for (const id of older.seen) bot.seen.add(id);
        older.stop();
        state.log("stopped previous poller (live reload)");
      } catch {}
    }
    botRegistry.push(bot);
    // Bound the registry: only the newest bot (and its immediate predecessor,
    // which may still be finishing its final getUpdates) needs to stay alive.
    while (botRegistry.length > 3) botRegistry.shift();

    // ── single-instance lock ──
    // Only ONE harness instance may poll the bot token (Telegram 409s a
    // second poller). Extra instances stay dormant and take over when the
    // lock-holder exits.
    const lockPath = join(dshHome(), "telegram-remote.lock");
    let holdLock = false;
    const isPidAlive = (pid) => {
      if (!pid) return false;
      try { process.kill(pid, 0); return true; } catch (error) { return error.code === "EPERM"; }
    };
    const tryAcquire = () => {
      try {
        const raw = readFileSync(lockPath, "utf8").trim();
        const other = Number(raw.split(/\s+/)[0]);
        if (other && other !== process.pid && isPidAlive(other)) return false;
      } catch {}
      try { writeFileSync(lockPath, process.pid + " " + nowIso() + "\n"); holdLock = true; } catch {}
      return holdLock;
    };
    const startBot = () => {
      // Inherit identity from a previous instance when possible: HMR reloads
      // re-run apply, and getMe is an extra Telegram round-trip we can skip.
      const inherited = (globalThis.__dshTelegramBots ?? [])
        .filter((b) => b !== bot && b.me)
        .map((b) => b.me)
        .pop();
      const ready = inherited
        ? Promise.resolve({ ...inherited })
        : bot.getMe();
      ready.then(async (me) => {
        bot.me = me;
        state.log("bot online: @" + me.username + " (id " + me.id + ")");
        try {
          const menuKey = JSON.stringify(COMMANDS_MENU);
          if (globalThis.__dshTgMenuKey !== menuKey) {
            await bot.setMyCommands(COMMANDS_MENU);
            globalThis.__dshTgMenuKey = menuKey;
            state.log("command menu published (" + COMMANDS_MENU.length + " shortcuts)");
          }
        } catch (error) {
          state.log("setMyCommands failed: " + error.message);
        }
        setupDispatch(state);
        setupJobsForwarding(state);
        if (!(globalThis.__dshTgStreaming ?? false)) {
          // One mux subscription per process: HMR reloads re-run apply, and a
          // fresh subscription per reload would re-handle every event and
          // post duplicate "Thinking" stubs for a single turn.
          globalThis.__dshTgStreaming = setupStreaming(state);
        }
        if (config.notifyOnStartup && !(globalThis.__dshTgStarted ?? false)) {
          // Only announce once per process — HMR reloads re-run apply and must
          // NOT spam the chat with a fresh "online" message every time.
          globalThis.__dshTgStarted = true;
          const targets = new Set([...(config.allowedUserIds ?? []), ...(config.ownerChatId != null ? [config.ownerChatId] : [])]);
          for (const chatId of targets) {
            state.push(chatId, "🟢 <b>DSH Remote online</b>\n─────── ⋆⋅☆⋅⋆ ───────\n<i>pid " + process.pid + " · " + esc(process.cwd()) + "\n/help for everything</i>");
          }
        }
      }).catch((error) => {
        state.log("getMe failed: " + error.message);
        setupDispatch(state);
      });
    };

    state.holdLockRef = () => holdLock;
    state.tryAcquireRef = tryAcquire;
    state.startBotRef = startBot;

    if (tryAcquire()) {
      state.log("bot lock acquired (pid " + process.pid + ")");
      startBot();
    } else {
      state.log("another instance holds the bot lock — dormant until it releases");
    }

    // Single watchdog per process: HMR reloads re-run apply, and each new
    // instance would otherwise stack another 30s interval forever. Each tick
    // resolves the CURRENT (newest) bot from the registry so the watchdog
    // keeps working across reloads.
    if (!(globalThis.__dshTgWatchdog ?? false)) {
      globalThis.__dshTgWatchdog = true;
      ctx.setInterval(() => {
        try {
          const st = globalThis.__dshTgState;
          if (!st) return;
          const current = (globalThis.__dshTelegramBots ?? []).at(-1);
          if (!current) {
            // No poller alive: try to claim the single-instance lock.
            if (!st.holdLockRef && st.tryAcquireRef && st.tryAcquireRef()) {
              st.log("bot lock acquired after retry");
              st.startBotRef?.();
            }
            return;
          }
          if (current.stopped) return;
          if (current.lastPollAt > 0 && Date.now() - current.lastPollAt > 180_000 && !current.loop) {
            st.log("watchdog: restarting poll loop");
            st.startBotRef?.();
          }
        } catch {}
      }, 30_000);
    }

    state.log("plugin loaded: pid " + process.pid + " cwd " + process.cwd() + " workspace " + config.workspaceRoot);

    return () => {
      try { state.bot.stop(); } catch {}
      try {
        const i = (globalThis.__dshTelegramBots ?? []).indexOf(bot);
        if (i >= 0) globalThis.__dshTelegramBots.splice(i, 1);
      } catch {}
      try { if (watchdog) ctx.clearInterval(watchdog); } catch {}
      try {
        if (holdLock) {
          const raw = readFileSync(lockPath, "utf8").trim();
          if (Number(raw.split(/\s+/)[0]) === process.pid) unlinkSync(lockPath);
        }
      } catch {}
      try { state.flushState(); } catch {}
      state.log("plugin disposed");
    };
  } catch (error) {
    logBoot(ctx, "plugin failed to start: " + (error.stack ?? error.message));
    return () => {};
  }
}

function setupDispatch(state) {
  const bot = state.bot;
  bot.start(async (update) => {
    const message = update.message;
    if (message && message.text) {
      await handleText(state, message.chat.id, message.from?.id, message.text, message.message_id);
      return;
    }
    if (message && message.photo?.length > 0) {
      // A photo with an optional caption becomes a message WITH the image.
      const largest = message.photo[message.photo.length - 1];
      await handlePhoto(state, message.chat.id, message.from?.id, largest.file_id, message.caption ?? "", message.message_id);
      return;
    }
    const callback = update.callback_query;
    if (callback && callback.data) {
      await bot.answerCallbackQuery(callback.id, "");
      const chatId = callback.message?.chat?.id;
      if (chatId == null) return;
      // Interactive keyboards (questions, approvals) route here first.
      const handled = handleInteractiveCallback(state, chatId, callback.data);
      if (!handled) await handleText(state, chatId, callback.from?.id, callback.data, null);
    }
  });
}

async function handlePhoto(state, chatId, userId, fileId, caption, messageId) {
  try {
    const authorized = userId != null && state.isAuthorized(userId);
    if (!authorized) {
      try {
        await state.bot.send(chatId, "⛔ <b>Unauthorized</b>\nYour telegram user id: <code>" + (userId ?? "unknown") + "</code>");
      } catch {}
      return;
    }
    const file = await state.bot.getFile(fileId);
    const bytes = await state.bot.downloadFile(file.file_path);
    const mediaType = /.png$/i.test(file.file_path ?? "") ? "image/png" : /.webp$/i.test(file.file_path ?? "") ? "image/webp" : "image/jpeg";
    const cs = state.chatState(chatId);
    if (messageId != null) cs.lastUserMessageId = messageId;
    if (!cs.sessionId) {
      try {
        const created = await callApi(state.ctx, "sessions", "create", { cwd: state.config.workspaceRoot || process.cwd() });
        cs.sessionId = created.sessionId;
        state.saveState();
      } catch {}
    }
    if (!cs.sessionId) {
      await state.bot.send(chatId, "No chat is open yet — tap 💬 New chat first.");
      return;
    }
    const text = caption || "see the attached image";
    const content = [{ type: "text", text }, { type: "image", mediaType, data: bytes.toString("base64") }];

    // Capability gate: the active model may be text-only (deepseek-v4-flash
    // etc.). Detect that BEFORE prompting, so the user gets a clear message
    // instead of a red "UNSUPPORTED_CONTENT" turn failure.
    const modelInfo = await currentModelModalities(state, cs.sessionId);
    if (!modelInfo.imageSupported) {
      const modelLabel = modelInfo.label ? " (<code>" + esc(modelInfo.label) + "</code>)" : "";
      const vision = modelInfo.visionSuggestions?.length
        ? "\n📷 Vision models you can switch to: <code>" + esc(modelInfo.visionSuggestions.join("</code> · <code>")) + "</code>\nSwitch with <code>/model &lt;id&gt;</code>"
        : "";
      await state.bot.send(
        chatId,
        "📷 <b>This model can't see images yet</b>" + modelLabel + "\n" +
        "Send your question as text instead, or switch to a vision-capable model first." + vision,
      );
      state.log("photo rejected: model " + (modelInfo.label ?? "?") + " has no image support");
      return;
    }

    await callApi(state.ctx, "sessions", "prompt", {
      sessionId: cs.sessionId,
      mode: "queue",
      content,
      clientTimeZone: (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return "UTC"; } })(),
    });
    state.notePrompt(cs.sessionId, text);
    state.log("photo sent to " + cs.sessionId + " by " + userId);
  } catch (error) {
    state.log("photo handling failed: " + (error.stack ?? error.message));
    try {
      await state.bot.send(chatId, "⚠️ Couldn't send the photo: " + esc(error.message));
    } catch {}
  }
}

/**
 * Resolve the ACTIVE model for a session and whether it supports image input.
 * Reads the model catalog (inputModalities) and the session's current model,
 * falling back to the default selection when the session is unattached.
 */
async function currentModelModalities(state, sessionId) {
  const ctx = state.ctx;
  let current = {};
  try {
    const r = await callApi(ctx, "sessions", "models", { sessionId });
    current = r?.current ?? {};
  } catch {}
  const def = ctx.get("agentDefaultModel")?.currentSelection?.() ?? {};
  const provider = current.provider ?? def.provider ?? "";
  const modelId = current.model ?? def.model ?? "";
  const label = (provider ? provider + "/" : "") + modelId;
  let imageSupported = false;
  let visionSuggestions = [];
  try {
    const catalog = await callApi(ctx, "llm", "models", {});
    const groups = Array.isArray(catalog) ? catalog : (catalog?.groups ?? []);
    for (const group of groups) {
      for (const model of group.models ?? []) {
        const modalities = model.inputModalities ?? [];
        const canSee = modalities.includes("image");
        const id = model.id ?? "";
        if (id === modelId) imageSupported = canSee;
        if (canSee && visionSuggestions.length < 4 && id !== modelId) visionSuggestions.push(id);
      }
    }
  } catch {}
  return { imageSupported, label, visionSuggestions };
}

function resolveToken(config) {
  if (config.botToken) return config.botToken;
  if (config.tokenEnv) {
    const value = process.env[config.tokenEnv];
    if (value) return value;
  }
  if (config.tokenFile) {
    try {
      const value = readFileSync(config.tokenFile, "utf8").trim();
      if (value) return value;
    } catch {}
  }
  try {
    const value = readFileSync(join(dshHome(), "telegram-remote.token"), "utf8").trim();
    if (value) return value;
  } catch {}
  return "";
}

function logBoot(ctx, message) {
  try { ctx.logger.warn("[telegram-remote] " + message); } catch {}
  try { appendFileSync(join(dshHome(), "telegram-remote.log"), "[" + nowIso() + "] " + message + "\n", "utf8"); } catch {}
}

export default { name, inject, apply };
