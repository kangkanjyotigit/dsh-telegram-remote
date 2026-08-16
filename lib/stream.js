/**
 * Live streaming engine: subscribes to the harness mux event stream (the same
 * stream the web UI uses) and renders agent work into Telegram as ONE
 * live-edited message per reply, in a clean structured layout:
 *
 *   🔵 THINKING      — live reasoning preview (beginning + end), quote-boxed
 *                       & italic so it can never be confused with the answer
 *   🟢 TOOLS         — every tool call with live status (⋯ running / ✅ done / ⚠️ error)
 *   🟣 REPLY         — live token stream once text starts
 *   ⏳ n s           — elapsed timer footer
 *
 * Every header is a colored bullet + bold caps; thinking content sits in
 * a <blockquote> card (accent-colored bar) with italic text.
 *
 * Final edit keeps the same structure but renders the full formatted markdown
 * (code, bold, …), with long replies split into follow-up messages.
 *
 * Also handles interactive frames: agent questions (ask_user_question) and
 * tool-approval requests, forwarded to Telegram with buttons.
 */

import { esc } from "./bot.js";
import { contentText, hasText, markdownToHtml, sleep, truncate } from "./util.js";

// Colored bullet + bold caps: every section gets its own accent color.
// (Telegram bots cannot set text colors, so the colored emoji bullets and
// the blockquote accent bar are the strongest color levers available.)
const THINKING_HEADER = "🔵 <b>THINKING</b>";
const TOOLS_HEADER = "🟢 <b>TOOLS</b>";
const REPLY_HEADER = "🟣 <b>REPLY</b>";
// Long underscore rule drawn under every section header — heavy
// box-drawing line with a sparkle star in the middle (user's pick: B).
const HEADER_RULE = "━━━━━━━━━━━ ✦ ━━━━━━━━━━━";
const DIVIDER = "─────── ⋆⋅☆⋅⋆ ───────";
const EDIT_INTERVAL_MS = 800;
const REASONING_HEAD = 350; // beginning of thinking shown in the bubble
const REASONING_TAIL = 350; // end of thinking shown in the bubble
const TEXT_PREVIEW = 2800;
const TOOLS_MAX = 6;
const EDIT_MAX = 3800; // Telegram edit limit is 4096; stay under for HTML overhead
const CHUNK_MAX = 4000;
const DONE_STREAM_TTL_MS = 5 * 60_000; // drop finished streams after 5min

/** Drop long-finished streams so the global map stays bounded. */
function pruneStreams(streams) {
  const now = Date.now();
  for (const [chatId, stream] of streams) {
    if (stream.done && now - (stream.finishedAt ?? now) > DONE_STREAM_TTL_MS) {
      streams.delete(chatId);
    }
  }
}

export function setupStreaming(state) {
  const api = state.ctx.get("apiProxy");
  if (!api?.events?.mux) {
    state.log("streaming unavailable: no apiProxy.events.mux");
    return () => {};
  }
  // Engine lives in globalThis so HMR reloads REPLACE the handler reference
  // while keeping ONE mux subscription. (The old per-apply guard froze the
  // first-loaded code in memory — later fixes never reached the running bot.)
  const engine = (globalThis.__dshTgStreamEngine ??= {
    streams: new Map(),
    started: false,
    abort: null,
    scheduleEdit: null,
    handleFrame: null,
  });
  const streams = engine.streams;

  // One shared edit timer for all chats: chunks arriving within the same
  // interval coalesce into a single Telegram edit instead of one timer each.
  let editTimer = null;
  const scheduleEdit = (chatId) => {
    const stream = streams.get(chatId);
    if (!stream || stream.msgId == null || stream.done || stream.editing) return;
    stream.editing = true;
    if (editTimer == null) {
      editTimer = setTimeout(() => {
        editTimer = null;
        for (const current of streams.values()) {
          if (!current.editing) continue;
          current.editing = false;
          if (current.msgId == null || current.done) continue;
          current.lastEdit = Date.now();
          state.bot.editMessageText(current.chatId, current.msgId, buildPreview(current)).catch(() => {});
        }
      }, EDIT_INTERVAL_MS);
    }
  };

  // Publish the LIVE handler: every reload replaces these with the newest
  // code, and the single subscription loop below dispatches through them.
  engine.scheduleEdit = scheduleEdit;
  engine.handleFrame = (frame) => handleFrame(state, streams, scheduleEdit, frame);

  // Self-healing subscription: if the mux stream ever closes (even cleanly
  // or with an error), reconnect after 5s instead of dying silently —
  // a dead stream used to mean the bot stopped delivering replies forever.
  const connect = (abort) => {
    const run = async () => {
      while (!abort.signal.aborted) {
        const subscribedAt = Date.now();
        try {
          const frames = api.events.mux({ rpcId: "tg-mux-" + Math.random().toString(36).slice(2, 10), payload: {} }, abort.signal);
          state.log("mux connected");
          for await (const frame of frames) {
            // Replay guard: after a reconnect the stream may re-deliver old
            // events; only frames newer than the subscription (15s grace)
            // are treated as live.
            const ft = frame?.payload?.event?.time ?? 0;
            if (ft > 0 && ft < subscribedAt - 15000) continue;
            try {
              engine.handleFrame?.(frame);
            } catch (error) {
              state.log("mux frame handler failed: " + (error.stack ?? error.message));
            }
          }
          state.log("mux stream closed — reconnecting in 5s");
        } catch (error) {
          if (abort.signal.aborted) return;
          state.log("mux stream ended: " + (error.message ?? error) + " — reconnecting in 5s");
        }
        await sleep(5000);
      }
    };
    return run();
  };

  if (!engine.started || !engine.loopAlive) {
    // Restart a dead loop (or replace a half-dead one) with a fresh
    // controller; each loop captures its own abort signal so superseded
    // loops exit cleanly and never double-subscribe.
    engine.abort?.abort();
    const ctrl = new AbortController();
    const token = {};
    engine.abort = ctrl;
    engine.loopToken = token;
    engine.started = true;
    engine.loopAlive = true;
    engine.loopPromise = connect(ctrl).catch(() => {}).finally(() => {
      if (engine.loopToken === token) {
        engine.loopAlive = false;
        engine.loopToken = null;
        engine.loopPromise = null;
      }
    });
  }

  return () => {
    // Never tear down on reload: the engine is shared via globalThis and the
    // reloaded module instance keeps driving it. Only the process-wide
    // teardown path (plugin never restarted) aborts the subscription.
    if (engine.handleFrame !== undefined && engine.handleFrame !== null) return;
    engine.abort?.abort();
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
        // mid-turn) instead of posting a duplicate "Thinking" message. The
        // posting flag guards against concurrent mux subscribers racing while
        // the first send is still in flight (msgId not yet assigned).
        const existing = streams.get(chatId);
        if (existing && !existing.done && existing.sessionId === sessionId) {
          existing.startedAt = Date.now();
          existing.editing = false;
          if (existing.msgId != null) scheduleEdit(chatId);
          continue;
        }
        if (existing && !existing.done && existing.posting) continue;
        const stream = {
          chatId,
          sessionId,
          msgId: null,
          posting: false,
          text: "",
          reasoning: "",
          tools: new Map(),
          startedAt: Date.now(),
          lastEdit: 0,
          editing: false,
          done: false,
        };
        pruneStreams(streams);
        streams.set(chatId, stream);
        stream.posting = true;
        state.log("streaming turn → chat " + chatId + " session " + sessionId.slice(0, 12));
        state.bot.send(chatId, THINKING_HEADER + "\n" + HEADER_RULE + "\n<i>⏳ 0s</i>", { replyToMessageId: chat.lastUserMessageId })
          .then((ids) => {
            stream.posting = false;
            const current = streams.get(chatId);
            if (current === stream && current.msgId == null) current.msgId = ids[0];
            state.log("thinking stub posted: chat " + chatId + " msg " + ids[0]);
          })
          .catch((e2) => { stream.posting = false; state.log("stub send failed: " + (e2?.message ?? e2)); });
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
    case "reasoning-chunks": {
      // Batched reasoning deltas from the mux stream (the high-frequency
      // carrier for thinking text). texts[] are individual delta strings.
      const texts = event.data?.texts;
      if (!Array.isArray(texts) || texts.length === 0) break;
      const joined = texts.join("");
      if (!joined) break;
      for (const { chatId, active } of chats) {
        if (!active) continue;
        const stream = streams.get(chatId);
        if (!stream || stream.done) continue;
        stream.reasoning += joined;
        if (stream.reasoning.length > 20000) stream.reasoning = stream.reasoning.slice(-20000);
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
      // Backup capture: the final message also carries full reasoning blocks,
      // so the thinking snippet survives even if delta events were missed.
      const reasoningText = (Array.isArray(blocks) ? blocks : [])
        .filter((b) => b?.type === "reasoning")
        .map((b) => (typeof b.text === "string" ? b.text : ""))
        .join("\n")
        .trim();
      for (const { chatId, active } of chats) {
        if (!active) continue;
        const stream = streams.get(chatId);
        state.log("assistant/message → chat " + chatId + " stream=" + (stream ? "yes" : "no"));
        if (stream) {
          if (reasoningText && reasoningText.length > stream.reasoning.length) stream.reasoning = reasoningText;
          stream.done = true;
          stream.finishedAt = Date.now();
          finalizeReply(state, stream, content);
        } else {
          state.bot.send(chatId, REPLY_HEADER + "\n" + markdownToHtml(truncate(content, 3600)), { replyToMessageId: state.chatState(chatId).lastUserMessageId })
            .catch((e) => state.log("fallback send failed: " + (e?.message ?? e)));
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
  const footer = DIVIDER + "\n<i>" + stats.join(" · ") + "</i>";
  // The live bubble is the SAME message as the final one — so the thinking
  // section stays in it, above the answer, forever (users scroll back to it).
  const thinking = stream.reasoning
    ? THINKING_HEADER + "\n" + HEADER_RULE + "\n" + reasoningSnippet(stream.reasoning) + "\n\n"
    : "";
  const full = thinking + REPLY_HEADER + "\n" + HEADER_RULE + "\n" + markdownToHtml(content) + "\n" + footer;

  const chunks = splitByLength(full, CHUNK_MAX);
  const fail = (e) => state.log("finalize send failed: " + (e?.message ?? e));
  let head = chunks[0];
  const tail = chunks.slice(1);
  if (stream.msgId != null) {
    // The live bubble is edited in place. If the head exceeds the edit
    // limit, cut it at a line boundary and send the remainder separately —
    // content is NEVER dropped (the old code silently lost the tail).
    if (head.length > EDIT_MAX) {
      let cut = head.lastIndexOf("\n", EDIT_MAX - 60);
      if (cut < EDIT_MAX * 0.6) cut = EDIT_MAX - 60;
      tail.unshift(head.slice(cut));
      head = head.slice(0, cut) + "\n…";
    }
    state.bot.editMessageText(stream.chatId, stream.msgId, head).catch(fail);
  } else {
    state.bot.send(stream.chatId, head, { replyToMessageId: state.chatState(stream.chatId).lastUserMessageId }).catch(fail);
  }
  for (const chunk of tail) {
    state.bot.send(stream.chatId, chunk).catch(fail);
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
  const ctype = chunk.type;
  if (ctype === "reasoning-delta") {
    if (typeof chunk.text === "string") stream.reasoning += chunk.text;
  } else if (ctype === "text-delta") {
    if (typeof chunk.text === "string") stream.text += chunk.text;
  } else if (ctype === "block-end") {
    const block = chunk.block;
    if (!block) return;
    if (block.type === "text" && typeof block.text === "string") {
      stream.text = block.text;
    } else if (block.type === "reasoning" && typeof block.text === "string") {
      stream.reasoning = block.text;
    }
  } else if (ctype === "delta" && chunk.block) {
    // Older harness shape: delta with an inline block
    const delta = typeof chunk.block.text === "string" ? chunk.block.text : "";
    if (!delta) return;
    if (chunk.block.type === "reasoning") stream.reasoning += delta;
    else if (chunk.block.type === "text") stream.text += delta;
  }
  if (stream.text.length > 20000) stream.text = stream.text.slice(-20000);
  if (stream.reasoning.length > 20000) stream.reasoning = stream.reasoning.slice(-20000);
}

/**
 * Compact head+tail preview of long thinking text — the beginning and the
 * end of the model's reasoning, with an ellipsis in between. Code-point safe
 * (emoji/surrogates never split) and HTML-escaped.
 */
function reasoningSnippet(raw) {
  const text = String(raw ?? "").trim();
  if (!text) return "";
  const chars = Array.from(text);
  // Quote-boxed + italic: the thinking renders as a distinct indented card
  // with a colored left border — impossible to confuse with the answer.
  const body = (chars.length <= REASONING_HEAD + REASONING_TAIL)
    ? "<i>" + esc(text) + "</i>"
    : "<i>" + esc(chars.slice(0, REASONING_HEAD).join("")) + "</i>\n<i>… thinking continues …</i>\n<i>" + esc(chars.slice(-REASONING_TAIL).join("")) + "</i>";
  return "<blockquote>" + body + "</blockquote>";
}

/** Render the live message with clean, clearly separated sections. */
function buildPreview(stream) {
  const elapsed = Math.max(0, Math.round((Date.now() - stream.startedAt) / 1000));
  const sections = [];

  if (stream.reasoning && !stream.done) {
    sections.push(THINKING_HEADER + "\n" + HEADER_RULE + "\n" + reasoningSnippet(stream.reasoning));
  }

  if (stream.tools.size > 0 && !stream.done) {
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
    sections.push(TOOLS_HEADER + "\n" + HEADER_RULE + "\n" + lines.join("   "));
  }

  if (stream.text) {
    sections.push(REPLY_HEADER + "\n" + HEADER_RULE + "\n" + truncate(stream.text.trim(), TEXT_PREVIEW));
  } else if (!stream.reasoning && stream.tools.size === 0) {
    sections.push(THINKING_HEADER + "\n" + HEADER_RULE);
  }

  // Blank line between every section keeps Thinking / Tools / Reply apart.
  sections.push(DIVIDER + "\n<i>⏳ " + elapsed + "s</i>");
  return sections.join("\n\n");
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
    if (q.detail) text += "\n<i>" + esc(truncate(q.detail, 300)) + "</i>";
    if (q.multiSelect) text += "\n<i>(multi-select: tap each, then send your final answer as a plain message)</i>";
    else text += "\n<i>Tap an option, or reply with your own answer as a plain message.</i>";
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
    (payload.reason ? "\n<i>" + esc(truncate(payload.reason, 300)) + "</i>" : "");
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
