/**
 * Live streaming engine: subscribes to the harness mux event stream (the same
 * stream the web UI uses) and renders agent work into Telegram as ONE
 * live-edited message per reply, in a clean structured layout:
 *
 *   💭 Thinking      — live reasoning tail while the model thinks
 *   🔧 Tools         — every tool call with live status (⋯ running / ✅ done / ⚠️ error)
 *   🤖 Reply         — live token stream once text starts
 *   ⏳ n s           — elapsed timer footer
 *
 * Final edit keeps the same structure but renders the full formatted markdown
 * (code, bold, …), with long replies split into follow-up messages.
 *
 * Also handles interactive frames: agent questions (ask_user_question) and
 * tool-approval requests, forwarded to Telegram with buttons.
 */

import { esc } from "./bot.js";
import { contentText, hasText, markdownToHtml, truncate } from "./util.js";

const THINKING_HEADER = "💭 <b>Thinking</b>";
const TOOLS_HEADER = "🔧 <b>Tools</b>";
const REPLY_HEADER = "🤖 <b>Reply</b>";
const DIVIDER = "─────── ⋆⋅☆⋅⋆ ───────";
const EDIT_INTERVAL_MS = 800;
const REASONING_PREVIEW = 700;
const TEXT_PREVIEW = 2800;
const TOOLS_MAX = 6;
const EDIT_MAX = 3800; // Telegram edit limit is 4096; stay under for HTML overhead
const CHUNK_MAX = 4000;

export function setupStreaming(state) {
  const api = state.ctx.get("apiProxy");
  if (!api?.events?.mux) {
    state.log("streaming unavailable: no apiProxy.events.mux");
    return () => {};
  }
  const abort = new AbortController();
  // Persistent across HMR reloads: a reload mid-turn must keep editing the
  // SAME live message instead of starting a second "Thinking" message.
  const streams = (globalThis.__dshTgStreams ??= new Map());

  const scheduleEdit = (chatId) => {
    const stream = streams.get(chatId);
    if (!stream || stream.editing) return;
    const now = Date.now();
    const wait = Math.max(0, stream.lastEdit + EDIT_INTERVAL_MS - now);
    stream.editing = true;
    setTimeout(() => {
      stream.editing = false;
      const current = streams.get(chatId);
      if (!current || current.msgId == null) return;
      current.lastEdit = Date.now();
      const body = buildPreview(current);
      state.bot.editMessageText(chatId, current.msgId, body).catch(() => {});
    }, wait);
  };

  (async () => {
    try {
      const frames = api.events.mux({ rpcId: "tg-mux-" + Math.random().toString(36).slice(2, 10), payload: {} }, abort.signal);
      for await (const frame of frames) {
        try {
          handleFrame(state, streams, scheduleEdit, frame);
        } catch (error) {
          state.log("mux frame handler failed: " + (error.stack ?? error.message));
        }
      }
    } catch (error) {
      if (!abort.signal.aborted) state.log("mux stream ended: " + error.message);
    }
  })();

  return () => {
    // Do NOT abort or clear on dispose: this stream map is shared via
    // globalThis and the reloaded module instance keeps driving it. Only the
    // process-wide teardown path (plugin never restarted) clears it.
    if (globalThis.__dshTgStreams !== streams) return;
    abort.abort();
    for (const stream of streams.values()) {
      if (stream.msgId != null) state.bot.deleteMessage(stream.chatId, stream.msgId).catch(() => {});
    }
    streams.clear();
  };
}

function handleFrame(state, streams, scheduleEdit, frame) {
  const payload = frame?.payload;
  if (!payload || typeof payload !== "object") return;
  switch (payload.type) {
    case "session/event":
      handleSessionEvent(state, streams, scheduleEdit, payload);
      break;
    case "question/requested":
      handleQuestionRequested(state, payload, frame.rpcId);
      break;
    case "approval/requested":
      handleApprovalRequested(state, payload, frame.rpcId);
      break;
    default:
      break;
  }
}

function interestedChats(state, sessionId) {
  const chats = [];
  for (const [chatId, chat] of state.chats) {
    if (chat.notify === "off") continue;
    if (chat.notify === "session" && sessionId !== chat.sessionId) continue;
    chats.push({ chatId, chat, active: sessionId === chat.sessionId });
  }
  return chats;
}

function handleSessionEvent(state, streams, scheduleEdit, frame) {
  const sessionId = frame.sessionId;
  const event = frame.event;
  if (!sessionId || !event) return;
  const chats = interestedChats(state, sessionId);
  if (chats.length === 0) return;

  switch (event.type) {
    case "turn/start": {
      for (const { chatId, chat, active } of chats) {
        if (!active) continue;
        // Reuse a live stream from a previous module instance (HMR reload
        // mid-turn) instead of posting a duplicate "Thinking" message.
        const existing = streams.get(chatId);
        if (existing && !existing.done && existing.sessionId === sessionId && existing.msgId != null) {
          existing.startedAt = Date.now();
          existing.editing = false;
          scheduleEdit(chatId);
          continue;
        }
        const stream = {
          chatId,
          sessionId,
          msgId: null,
          text: "",
          reasoning: "",
          tools: new Map(),
          startedAt: Date.now(),
          lastEdit: 0,
          editing: false,
          done: false,
        };
        streams.set(chatId, stream);
        state.bot.send(chatId, THINKING_HEADER + "\n<small>⏳ 0s</small>", { replyToMessageId: chat.lastUserMessageId })
          .then((ids) => {
            const current = streams.get(chatId);
            if (current && current.sessionId === sessionId && current.msgId == null) current.msgId = ids[0];
          })
          .catch(() => {});
      }
      break;
    }
    case "assistant/chunk": {
      const chunk = event.data?.chunk;
      if (!chunk) break;
      for (const { chatId, active } of chats) {
        if (!active) continue;
        const stream = streams.get(chatId);
        if (!stream || stream.done) continue;
        applyChunk(stream, chunk);
        scheduleEdit(chatId);
      }
      break;
    }
    case "assistant/message": {
      // Only real text blocks count as the reply. Tool-call-only messages
      // (the model asking to use tools) are already shown live in the Tools
      // section — finalizing on them would print raw JSON as the reply.
      const blocks = event.data?.message?.content;
      if (!hasText(blocks)) break;
      const content = contentText(blocks, { textOnly: true });
      if (!content) break;
      for (const { chatId, active } of chats) {
        if (!active) continue;
        const stream = streams.get(chatId);
        if (stream) {
          stream.done = true;
          finalizeReply(state, stream, content);
        } else {
          state.bot.send(chatId, REPLY_HEADER + "\n" + markdownToHtml(truncate(content, 3600)), { replyToMessageId: state.chatState(chatId).lastUserMessageId }).catch(() => {});
        }
      }
      break;
    }
    case "tool/call": {
      const callId = event.data?.callId;
      const name = event.data?.name ?? "?";
      for (const { chatId, active } of chats) {
        if (!active) continue;
        const stream = streams.get(chatId);
        if (stream && !stream.done) {
          stream.tools.set(callId, { name, status: "running" });
          scheduleEdit(chatId);
        }
      }
      break;
    }
    case "tool/result": {
      const callId = event.data?.message?.source?.callId;
      if (!callId) break;
      const isError = !!event.data?.message?.isError;
      for (const { chatId, active } of chats) {
        if (!active) continue;
        const stream = streams.get(chatId);
        if (!stream || stream.done) continue;
        const tool = stream.tools.get(callId);
        if (tool) {
          tool.status = isError ? "error" : "done";
          scheduleEdit(chatId);
        }
      }
      break;
    }
    case "turn/end": {
      const reason = event.data?.reason;
      if (!reason) break;
      for (const { chatId, active } of chats) {
        if (!active) continue;
        const stream = streams.get(chatId);
        if (!stream) continue;
        if (reason.kind === "interrupted") {
          if (!stream.done) {
            stream.done = true;
            state.bot.editMessageText(chatId, stream.msgId, "⏹ <b>Stopped</b>").catch(() => {});
          }
        } else if (reason.kind !== "completed" && !stream.done) {
          stream.done = true;
          const detail = reason.error?.message ? ": " + truncate(String(reason.error.message), 300) : "";
          state.bot.editMessageText(chatId, stream.msgId, "⚠️ <b>" + esc(reason.kind) + "</b>" + esc(detail)).catch(() => {});
        }
      }
      break;
    }
    case "user/message": {
      const content = contentText(event.data?.content);
      if (!content) break;
      if (state.isRecentPrompt(sessionId, content)) break;
      for (const { chatId, active } of chats) {
        if (active) continue;
        state.bot.send(chatId, "🧑 " + truncate(content, 600), { replyToMessageId: state.chatState(chatId).lastUserMessageId }).catch(() => {});
      }
      break;
    }
    default:
      break;
  }
}

/** Final, structured reply: edit the live message, then send overflow chunks. */
function finalizeReply(state, stream, content) {
  const elapsed = Math.max(1, Math.round((Date.now() - stream.startedAt) / 1000));
  const stats = [];
  if (stream.tools.size) stats.push("🔧 " + stream.tools.size + (stream.tools.size === 1 ? " tool" : " tools"));
  stats.push("⏱ " + elapsed + "s");
  const footer = DIVIDER + "\n<small>" + stats.join(" · ") + "</small>";
  const full = REPLY_HEADER + "\n" + markdownToHtml(content) + "\n" + footer;

  const chunks = splitByLength(full, CHUNK_MAX);
  const head = chunks[0].length <= EDIT_MAX ? chunks[0] : truncate(chunks[0], EDIT_MAX - 60) + "\n…";
  if (stream.msgId != null) {
    state.bot.editMessageText(stream.chatId, stream.msgId, head).catch(() => {});
  } else {
    state.bot.send(stream.chatId, head, { replyToMessageId: state.chatState(stream.chatId).lastUserMessageId }).catch(() => {});
  }
  for (const chunk of chunks.slice(1)) {
    state.bot.send(stream.chatId, chunk).catch(() => {});
  }
}

function splitByLength(text, max) {
  if (text.length <= max) return [text];
  const chunks = [];
  let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf("\n", max);
    if (cut <= 0) cut = max;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest.length > 0) chunks.push(rest);
  return chunks;
}

function applyChunk(stream, chunk) {
  if (chunk.type === "delta") {
    const block = chunk.block;
    if (!block) return;
    const delta = typeof block.text === "string" ? block.text : "";
    if (!delta) return;
    if (block.type === "reasoning") {
      stream.reasoning += delta;
    } else if (block.type === "text") {
      stream.text += delta;
    }
  } else if (chunk.type === "block-end") {
    const block = chunk.block;
    if (!block) return;
    if (block.type === "text" && typeof block.text === "string") {
      stream.text = block.text;
    } else if (block.type === "reasoning" && typeof block.text === "string") {
      stream.reasoning = block.text;
    }
  }
  if (stream.text.length > 20000) stream.text = stream.text.slice(-20000);
  if (stream.reasoning.length > 8000) stream.reasoning = stream.reasoning.slice(-8000);
}

/** Render the live message with clean, structured sections. */
function buildPreview(stream) {
  const elapsed = Math.max(0, Math.round((Date.now() - stream.startedAt) / 1000));
  const parts = [];

  if (stream.reasoning && !stream.done) {
    parts.push(THINKING_HEADER);
    parts.push(truncate(stream.reasoning.trim(), REASONING_PREVIEW));
  }

  if (stream.tools.size > 0 && !stream.done) {
    parts.push(TOOLS_HEADER);
    const lines = [];
    let idx = 0;
    for (const tool of stream.tools.values()) {
      if (idx >= TOOLS_MAX) {
        lines.push("+ " + (stream.tools.size - idx) + " more");
        break;
      }
      idx += 1;
      const icon = tool.status === "done" ? "✅" : tool.status === "error" ? "⚠️" : "⋯";
      lines.push(icon + " <code>" + esc(tool.name) + "</code>");
    }
    parts.push(lines.join("   "));
  }

  if (stream.text) {
    parts.push(REPLY_HEADER);
    parts.push(truncate(stream.text.trim(), TEXT_PREVIEW));
  } else if (!stream.reasoning && stream.tools.size === 0) {
    parts.push("💭 Thinking…");
  }

  parts.push(DIVIDER, "<small>⏳ " + elapsed + "s</small>");
  return parts.join("\n");
}

/* ── interactive: questions & approvals ── */

const QUESTION_CB = "qa:";
const APPROVE_CB = "ap:y:";
const REJECT_CB = "ap:n:";

function handleQuestionRequested(state, payload, rpcId) {
  const sessionId = payload.sessionId;
  const questions = payload.questions ?? [];
  if (!questions.length) return;
  const chats = interestedChats(state, sessionId);
  if (!chats.length) return;
  for (const { chatId, active } of chats) {
    if (!active) continue;
    const q = questions[0];
    const rows = (q.options ?? []).map((opt, idx) => [{
      text: truncate(opt.label, 40),
      callback_data: QUESTION_CB + rpcId + ":" + idx,
    }]);
    const keyboard = rows.length ? { inline_keyboard: rows } : undefined;
    let text = "❓ <b>" + esc(q.question) + "</b>";
    if (q.header) text = "❓ <b>" + esc(q.header) + "</b>\n" + esc(q.question);
    if (q.detail) text += "\n<small>" + esc(truncate(q.detail, 300)) + "</small>";
    if (q.multiSelect) text += "\n<small>(multi-select: tap each, then send your final answer as a plain message)</small>";
    else text += "\n<small>Tap an option, or reply with your own answer as a plain message.</small>";
    const chat = state.chatState(chatId);
    chat.pendingQuestion = { rpcId, sessionId, questionId: q.id, options: q.options ?? [], multiSelect: !!q.multiSelect, at: Date.now() };
    state.saveState();
    state.bot.send(chatId, text, { replyMarkup: keyboard }).catch(() => {});
  }
}

function handleApprovalRequested(state, payload, rpcId) {
  const sessionId = payload.sessionId;
  const chats = interestedChats(state, sessionId);
  if (!chats.length) return;
  const text = "🛡️ <b>Permission needed</b>\n" +
    "The AI wants to use <code>" + esc(payload.toolName ?? "a tool") + "</code>" +
    (payload.reason ? "\n<small>" + esc(truncate(payload.reason, 300)) + "</small>" : "");
  const keyboard = {
    inline_keyboard: [
      [
        { text: "✅ Allow once", callback_data: APPROVE_CB + rpcId },
        { text: "❌ Reject", callback_data: REJECT_CB + rpcId },
      ],
    ],
  };
  for (const { chatId, active } of chats) {
    if (!active) continue;
    const chat = state.chatState(chatId);
    chat.pendingApproval = { sessionId, rpcId, at: Date.now() };
    state.saveState();
    state.bot.send(chatId, text, { replyMarkup: keyboard }).catch(() => {});
  }
}

export function handleInteractiveCallback(state, chatId, data) {
  if (data.startsWith(QUESTION_CB)) {
    const rest = data.slice(QUESTION_CB.length);
    const sep = rest.lastIndexOf(":");
    if (sep < 0) return false;
    const rpcId = rest.slice(0, sep);
    const idx = Number(rest.slice(sep + 1));
    const chat = state.chatState(chatId);
    const pending = chat.pendingQuestion;
    if (!pending || pending.rpcId !== rpcId || !pending.options[idx]) return true;
    const label = pending.options[idx].label;
    const payload = {
      sessionId: pending.sessionId,
      answer: { answers: [{ id: pending.questionId, selected: [label] }] },
    };
    void answerQuestion(state, rpcId, payload);
    chat.pendingQuestion = undefined;
    state.saveState();
    return true;
  }
  if (data.startsWith(APPROVE_CB) || data.startsWith(REJECT_CB)) {
    const approve = data.startsWith(APPROVE_CB);
    const rpcId = data.slice(approve ? APPROVE_CB.length : REJECT_CB.length);
    const api = state.ctx.get("apiProxy");
    if (!api?.respond) return true;
    const chat = state.chatState(chatId);
    const payload = {
      sessionId: chat.pendingApproval?.sessionId ?? "",
      approvalId: rpcId,
      outcome: approve ? "allowed-once" : "rejected",
    };
    if (chat.pendingApproval) {
      chat.pendingApproval = undefined;
      state.saveState();
    }
    api.respond({ type: "client-response", rpcId, method: "respond", payload })
      .then((receipt) => state.log("approval respond: " + JSON.stringify(receipt)))
      .catch((error) => state.log("approval respond failed: " + error.message));
    return true;
  }
  return false;
}

async function answerQuestion(state, rpcId, payload) {
  const api = state.ctx.get("apiProxy");
  if (!api?.respond) {
    state.log("question respond unavailable");
    return;
  }
  try {
    const receipt = await api.respond({ type: "client-response", rpcId, method: "respond", payload });
    state.log("question respond: " + JSON.stringify(receipt));
  } catch (error) {
    state.log("question respond failed: " + error.message);
  }
}
