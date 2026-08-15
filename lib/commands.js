/**
 * Command handlers for dsh-telegram-remote.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, isAbsolute, resolve } from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { esc } from "./bot.js";
import { dshHome, invoke, callApi, pretty, truncate, fmtAge, shortId, contentText } from "./util.js";
import { cmdRename, cmdFork, cmdSearch, cmdExport, cmdWorkspaces, cmdWs, cmdMkdir, cmdArchive, cmdInterrupt, cmdAgentLog, cmdPresets, cmdPreset, cmdSkills, cmdPlugins, cmdSettings, cmdSetting, cmdCreds, cmdPermission } from "./features.js";

export const KEYBOARD = {
  inline_keyboard: [
    [
      { text: "💬 New chat", callback_data: "/new" },
      { text: "📋 My chats", callback_data: "/chats" },
    ],
    [
      { text: "🧠 Model", callback_data: "/models" },
      { text: "📊 Status", callback_data: "/status" },
    ],
    [
      { text: "❓ Help", callback_data: "/help" },
      { text: "⏹ Stop AI", callback_data: "/stop" },
      { text: "🔔 Notify", callback_data: "/notify" },
    ],
  ],
};

export const BUSY_KEYBOARD = {
  inline_keyboard: [
    [
      { text: "▶️ Send now", callback_data: "/steernow" },
      { text: "⏳ Queue it", callback_data: "/queuemsg" },
    ],
  ],
};

/** Telegram native command menu — EVERY command the bot supports. */
export const COMMANDS_MENU = [
  { command: "start", description: "Welcome & quick start" },
  { command: "help", description: "Full guide to everything" },
  { command: "new", description: "Start a fresh chat" },
  { command: "chats", description: "List chats — reply a number to open" },
  { command: "sessions", description: "List chats (same as /chats)" },
  { command: "open", description: "Open a chat by id or number" },
  { command: "msg", description: "Send a message to the chat" },
  { command: "log", description: "Recent messages of the chat" },
  { command: "stop", description: "Stop the AI" },
  { command: "queue", description: "Queued messages — steer/edit/remove" },
  { command: "steer", description: "Send into the running turn now" },
  { command: "edit", description: "Rewrite a queued message" },
  { command: "remove", description: "Remove a queued message" },
  { command: "status", description: "What's happening right now" },
  { command: "model", description: "This chat's model" },
  { command: "models", description: "Browse available models" },
  { command: "rename", description: "Rename a chat" },
  { command: "fork", description: "Copy a chat to experiment" },
  { command: "search", description: "Search past conversations" },
  { command: "export", description: "Download a chat as a file" },
  { command: "archive", description: "Tuck a chat away" },
  { command: "workspaces", description: "Folders your chats live in" },
  { command: "ws", description: "Workspace: new|rename|delete" },
  { command: "agents", description: "Subagent children of this chat" },
  { command: "send", description: "Message a subagent" },
  { command: "interrupt", description: "Stop a subagent" },
  { command: "agentlog", description: "A subagent's recent messages" },
  { command: "cmd", description: "Run a PowerShell command" },
  { command: "fs", description: "Files: ls|read|write|rm|stat" },
  { command: "mkdir", description: "Create a folder" },
  { command: "jobs", description: "Background tasks" },
  { command: "kill", description: "Kill a background task" },
  { command: "goal", description: "Goal: get|create|pause|clear|..." },
  { command: "permission", description: "Chat access: read|write|full" },
  { command: "presets", description: "Agent presets" },
  { command: "preset", description: "Switch this chat's preset" },
  { command: "skills", description: "Available skills" },
  { command: "plugins", description: "Loaded plugins" },
  { command: "settings", description: "Settings sections" },
  { command: "setting", description: "Change a setting (JSON)" },
  { command: "creds", description: "API keys: describe|set|unset" },
  { command: "raw", description: "Call any harness endpoint" },
  { command: "api", description: "List all harness endpoints" },
  { command: "config", description: "Show config files" },
  { command: "eval", description: "Run JS in the harness" },
  { command: "notify", description: "Notifications on/off/all" },
  { command: "reboot", description: "Restart the harness (same port)" },
  { command: "shutdown", description: "Stop the harness" },
  { command: "whoami", description: "Your telegram id" },
];

export const HELP = "" +
  "📖 <b>How to use me</b>\n\n" +
  "Just <b>type a message</b> and I'll send it to your AI — the reply streams here live.\n" +
  "─────── ⋆⋅☆⋅⋆ ───────\n\n" +
  "🗨 <b>Chat</b>\n" +
  "💬 <code>/new</code> — start a fresh chat\n" +
  "📋 <code>/chats</code> — see your chats (reply a number to open one)\n" +
  "🧠 <code>/model</code> — switch the AI's model (try <code>/model max</code>)\n" +
  "📊 <code>/status</code> — what's happening right now\n" +
  "⏹ <code>/stop</code> — stop the AI if it's working\n" +
  "📥 <code>/queue</code> — messages waiting (edit / steer / remove them)\n" +
  "🔔 <code>/notify on|off</code> — reply notifications on/off\n\n" +
  "🛠 <b>Control</b>\n" +
  "<code>/cmd &lt;powershell&gt;</code> — run a command on the computer\n" +
  "<code>/fs read|ls &lt;path&gt;</code> — look at files\n" +
  "<code>/jobs</code> / <code>/kill &lt;job&gt;</code> — background tasks\n" +
  "<code>/goal</code> — set &amp; track a long-running objective\n" +
  "🔐 <code>/permission</code> — chat access: read | write | full\n\n" +
  "🧩 <b>Explore</b>\n" +
  "<code>/agents</code> — subagents · <code>/presets</code> — agent presets\n" +
  "<code>/skills</code> — skills · <code>/plugins</code> — loaded plugins\n" +
  "<code>/export</code> — download a chat · <code>/search</code> — find things\n\n" +
  "─────── ⋆⋅☆⋅⋆ ───────\n" +
  "<i>Everything runs on your own computer. Only you can talk to this bot.</i>";

export const WELCOME = "" +
  "👋 <b>Welcome to your DeepSeek Harness</b> 🚀\n" +
  "<i>your AI, in your pocket</i>\n\n" +
  "─────── ⋆⋅☆⋅⋆ ───────\n\n" +
  "💬 <b>Chat</b> — just type a message and I'll pass it to your AI\n" +
  "🛠️ <b>Do</b> — write code, run commands, manage files\n" +
  "📊 <b>Watch</b> — live streams, status, chats, tasks\n\n" +
  "─────── ⋆⋅☆⋅⋆ ───────\n\n" +
  "Try typing <b>hello</b>, or tap a button below 👇";

export const COMMAND_TABLE = {
  start: cmdStart,
  welcome: cmdStart,
  help: cmdHelp,
  chats: cmdSessions,
  chat: cmdSessions,
  status: cmdStatus,
  models: cmdModels,
  model: cmdModel,
  sessions: cmdSessions,
  list: cmdSessions,
  open: cmdOpen,
  use: cmdOpen,
  new: cmdNew,
  msg: cmdMsg,
  q: cmdMsg,
  steer: cmdSteer,
  steernow: cmdSteerNow,
  queuemsg: cmdQueueMsg,
  queue: cmdQueue,
  edit: cmdEdit,
  remove: cmdRemove,
  stop: cmdStop,
  jobs: cmdJobs,
  kill: cmdKill,
  goal: cmdGoal,
  agents: cmdAgents,
  send: cmdSubagentSend,
  cmd: cmdShell,
  sh: cmdShell,
  fs: cmdFs,
  log: cmdLog,
  raw: cmdRaw,
  api: cmdApi,
  eval: cmdEval,
  config: cmdConfig,
  notify: cmdNotify,
  reboot: cmdReboot,
  shutdown: cmdShutdown,
  whoami: cmdWhoami,
  // full-harness feature commands (features.js)
  rename: cmdRename,
  fork: cmdFork,
  search: cmdSearch,
  export: cmdExport,
  workspaces: cmdWorkspaces,
  ws: cmdWs,
  mkdir: cmdMkdir,
  archive: cmdArchive,
  interrupt: cmdInterrupt,
  agentlog: cmdAgentLog,
  presets: cmdPresets,
  preset: cmdPreset,
  skills: cmdSkills,
  plugins: cmdPlugins,
  settings: cmdSettings,
  setting: cmdSetting,
  creds: cmdCreds,
  permission: cmdPermission,
};

async function cmdHelp(r) {
  return HELP;
}

async function cmdStart(r) {
  // New chats: notifications are on by default so replies always arrive.
  const state = r.state.chatState(r.chatId);
  if (state.notify !== "session" && state.notify !== "all") {
    state.notify = "session";
    r.state.saveState();
  }
  return WELCOME;
}

async function cmdWhoami(r) {
  return "your telegram user id: <code>" + r.userId + "</code>\nchat id: <code>" + r.chatId + "</code>\nauthorized: <code>" + r.authorized + "</code>";
}

export async function collectJobs(ctx) {
  const jobs = ctx.get("jobs");
  if (!jobs) return [];
  const agents = ctx.get("agents");
  const sessions = ctx.get("sessions");
  const seen = new Map();
  for (const session of sessions.list()) {
    const agent = agents.get(session.id);
    if (!agent) continue;
    try {
      for (const job of jobs.list(agent)) seen.set(job.id, job);
    } catch {}
  }
  try {
    for (const job of jobs.list(undefined)) seen.set(job.id, job);
  } catch {}
  return [...seen.values()];
}

async function cmdStatus(r) {
  const lines = ["📊 <b>Status</b>\n─────── ⋆⋅☆⋅⋆ ───────"];
  const gateway = r.ctx.get("typertGateway");
  try {
    const host = await callApi(r.ctx, "host", "describe", {});
    lines.push("🟢 <b>Online</b> — " + (host.provider ? "model " + esc(host.provider) + "/" + esc(host.model ?? "?") : "ready"));
  } catch {
    lines.push("🟢 <b>Online</b>");
  }
  try {
    const sessions = await r.state.listSessions();
    const running = sessions.filter((item) => item.running).length;
    lines.push("💬 <b>Chats</b> — " + sessions.length + " total · " + running + " working");
    const active = r.state.chatState(r.chatId).sessionId;
    if (active) {
      const title = sessions?.find((item) => item.sessionId === active)?.projections?.values?.title;
      lines.push("   📌 <small>current: " + esc(title ?? shortId(active)) + "</small>");
    }
  } catch {
    lines.push("💬 Chats: n/a");
  }
  try {
    const jobs = await collectJobs(r.ctx);
    const activeJobs = jobs.filter((job) => job.status === "running" || job.status === "stopping");
    lines.push("⚙️ <b>Tasks</b> — " + jobs.length + " total · " + activeJobs.length + " running");
  } catch {
    lines.push("⚙️ Tasks: n/a");
  }
  try {
    const goal = await getGoal(r.ctx, r.state, r.chatId);
    if (goal) lines.push("🎯 <b>Goal</b> — " + esc(truncate(goal.objective, 100)) + " (" + goal.phase + ")");
  } catch {}
  lines.push(
    "🖥️ <b>Computer</b> — pid " + process.pid + " · up " + fmtAge(Date.now() - Math.floor(process.uptime() * 1000)),
    "🤖 <b>Bot</b> — " + esc(r.state.bot.me?.username ?? "?") + " · polling " + (r.state.bot.lastPollAt ? fmtAge(r.state.bot.lastPollAt) : "starting"),
  );
  lines.push("─────── ⋆⋅☆⋅⋆ ───────");
  return lines.join("\n");
}

async function getCatalog(ctx) {
  const result = await callApi(ctx, "llm", "models", {});
  return result?.groups ?? [];
}

async function currentModelInfo(ctx, state, chatId) {
  const sessionId = await state.resolveSessionId(chatId, "");
  let current = {};
  if (sessionId) {
    try {
      const r = await callApi(ctx, "sessions", "models", { sessionId });
      current = r?.current ?? {};
    } catch {}
  }
  const def = ctx.get("agentDefaultModel")?.currentSelection?.() ?? {};
  return { sessionId, current, def };
}

async function cmdModels(r) {
  const catalog = await getCatalog(r.ctx);
  if (!catalog || catalog.length === 0) return "No models are available right now — check your API keys in the web Models page.";
  const lines = ["🧠 <b>Available models</b>\n─────── ⋆⋅☆⋅⋆ ───────", "switch: <code>/model &lt;id&gt;</code> · deepest: <code>/model max</code>"];
  for (const group of catalog) {
    lines.push("\n✦ <b>" + esc(group.name || group.id) + "</b>");
    for (const model of group.models) {
      const efforts = (model.reasoning?.efforts ?? []).map((e) => e.id);
      const hasMax = efforts.includes("max");
      lines.push("• <code>" + esc(model.id) + "</code>" + (hasMax ? " ⭐max" : "") + (efforts.length ? " <small>(" + esc(efforts.join("/")) + ")</small>" : ""));
    }
  }
  lines.push("─────── ⋆⋅☆⋅⋆ ───────");
  return truncate(lines.join("\n"), 3800);
}

async function cmdModel(r) {
  const args = r.args;
  const sessionId = await r.state.resolveSessionId(r.chatId, "");
  if (!sessionId) return "Open a chat first (tap 💬 New chat), then /model works.";
  if (args.length === 0) {
    const info = await currentModelInfo(r.ctx, r.state, r.chatId);
    const lines = [];
    if (info.current?.provider) {
      lines.push("<b>This chat</b>: " + esc(info.current.provider) + " / " + esc(info.current.model) + (info.current.reasoningEffort ? " · " + esc(info.current.reasoningEffort) : ""));
    } else {
      lines.push("<b>This chat</b>: using the default");
    }
    if (info.def?.provider) {
      lines.push("<b>Default</b>: " + esc(info.def.provider) + " / " + esc(info.def.model) + (info.def.reasoningEffort ? " · " + esc(info.def.reasoningEffort) : ""));
    }
    lines.push("", "/models to browse · /model &lt;id&gt; to switch · /model max for deepest thinking");
    return lines.join("\n");
  }
  const first = args[0].toLowerCase();
  if (first === "max" || first === "deep" || first === "deepest") {
    return setSessionModel(r, sessionId, { reasoningEffort: "max" });
  }
  if (first === "default") {
    const prov = args[1];
    const model = args[2];
    const effort = args[3];
    if (!prov || !model) return "usage: /model default &lt;provider&gt; &lt;model&gt; [effort]";
    const settings = r.ctx.get("settings");
    if (!settings || typeof settings.replace !== "function") return "Settings service unavailable.";
    await settings.replace("agent-default-model", {
      provider: prov,
      model,
      ...(effort ? { reasoningEffort: effort } : {}),
    });
    return "✅ Default model set: " + esc(prov) + " / " + esc(model) + (effort ? " · " + esc(effort) : "") + "\nApplies to new chats.";
  }
  // /model <model-id> [effort]  or  /model <provider> <model-id> [effort]
  const catalog = await getCatalog(r.ctx);
  let provider = null;
  let model = null;
  let effort = null;
  if (args.length >= 2 && catalog.some((g) => g.id === args[0])) {
    provider = args[0];
    model = args[1];
    effort = args[2];
  } else {
    model = args[0];
    effort = args[1];
  }
  if (!provider) {
    const group = catalog.find((g) => g.models.some((m) => m.id === model));
    provider = group?.id ?? null;
  }
  if (!provider || !model) return "I couldn't find that model — /models lists what's available.";
  return setSessionModel(r, sessionId, { provider, model, ...(effort ? { reasoningEffort: effort } : {}) });
}

async function setSessionModel(r, sessionId, { provider, model, reasoningEffort }) {
  let current = {};
  try {
    const r2 = await callApi(r.ctx, "sessions", "models", { sessionId });
    current = r2?.current ?? {};
  } catch {}
  const payload = {
    sessionId,
    provider: provider ?? current.provider,
    model: model ?? current.model,
    ...(reasoningEffort ? { reasoningEffort } : {}),
  };
  if (!payload.provider || !payload.model) return "This chat has no model yet — pick one from /models.";
  await callApi(r.ctx, "sessions", "selectModel", payload);
  return "✅ This chat now uses <b>" + esc(payload.provider) + " / " + esc(payload.model) + "</b>" + (payload.reasoningEffort ? " · " + esc(payload.reasoningEffort) : "") + "\nSend a message to use it.";
}

async function cmdSessions(r) {
  const sessions = await r.state.listSessions();
  if (!sessions || sessions.length === 0) return "No chats yet — tap 💬 New chat and say hi!";
  const active = r.state.chatState(r.chatId).sessionId;
  const chatState = r.state.chatState(r.chatId);
  chatState.sessionIds = sessions.map((item) => item.sessionId);
  chatState.lastListAt = Date.now();
  r.state.saveState();
  const show = sessions.slice(0, 10);
  const lines = ["📋 <b>Your chats</b>\n─────── ⋆⋅☆⋅⋆ ───────", "reply with a <b>number</b> to open one:"];
  show.forEach((item, index) => {
    const mark = item.sessionId === active ? " 👈" : "";
    const status = item.running ? "🏃" : item.blank ? "⬜" : "💤";
    const title = item.projections?.values?.title;
    lines.push(
      (index + 1) + ". " + status + " <b>" + esc(title ?? "untitled") + "</b>" + mark + "\n   <small>" + fmtAge(item.updatedAt) + (item.cwd ? " · " + esc(item.cwd) : "") + "</small>",
    );
  });
  if (sessions.length > show.length) lines.push("<small>…and " + (sessions.length - show.length) + " more</small>");
  lines.push("─────── ⋆⋅☆⋅⋆ ───────", "💬 <code>/new</code> starts a fresh chat");
  return lines.join("\n");
}

async function cmdOpen(r) {
  const arg = r.args[0];
  if (!arg) {
    const state = r.state.chatState(r.chatId);
    return state.sessionId ? "current chat: <code>" + state.sessionId + "</code>" : "No chat open yet — use 💬 New chat or 📋 My chats";
  }
  let sessionId = null;
  const chatState = r.state.chatState(r.chatId);
  if (/^\d+$/.test(arg) && chatState.sessionIds?.length > 0 && Date.now() - (chatState.lastListAt ?? 0) < 10 * 60_000) {
    const index = Number(arg) - 1;
    sessionId = chatState.sessionIds[index] ?? null;
    if (!sessionId) return "That number isn't in the list — send /chats again";
  }
  if (!sessionId) {
    sessionId = await r.state.resolveSessionId(r.chatId, arg);
  }
  if (!sessionId) return "I couldn't find that chat: " + esc(arg) + " — try /chats";
  chatState.sessionId = sessionId;
  r.state.saveState();
  const sessions = await r.state.listSessions();
  const title = sessions?.find((item) => item.sessionId === sessionId)?.projections?.values?.title;
  return "✅ Opened <b>" + esc(title ?? sessionId.slice(0, 12) + "…") + "</b>\nJust type your message — the reply streams right here. 💬";
}

async function cmdNew(r) {
  const cwd = r.args[0] || r.state.config.workspaceRoot || process.cwd();
  const created = await callApi(r.ctx, "sessions", "create", { cwd });
  const sessionId = created.sessionId;
  r.state.chatState(r.chatId).sessionId = sessionId;
  r.state.saveState();
  return "✅ <b>New chat ready!</b>\nSend me your first message — the AI's reply will stream right here. 😊";
}

export async function cmdMsg(r) {
  // Plain text (no leading "/") → the WHOLE message is the text. r.rest would
  // drop the first word; /msg <text> keeps using r.rest (the part after /msg).
  let text = r.text.startsWith("/") ? r.rest : r.text;
  if (!text) return "What should I tell your AI? Just type your message 🙂";
  // Friendly default: if no chat is open yet, create one automatically.
  const cs = r.state.chatState(r.chatId);
  if (!cs.sessionId) {
    try {
      const created = await callApi(r.ctx, "sessions", "create", { cwd: r.state.config.workspaceRoot || process.cwd() });
      cs.sessionId = created.sessionId;
      r.state.saveState();
    } catch {}
  }
  const agents = r.ctx.get("agents");
  const busy = agents?.get(cs.sessionId)?.status === "running";
  if (busy) {
    // Offer a choice: steer it in now, or queue it for after the current work.
    cs.pendingText = text;
    cs.pendingAt = Date.now();
    r.state.saveState();
    return {
      text: "🤖 The AI is working on something. Send this message <b>now</b> (steer it in) or <b>queue</b> it?",
      keyboard: BUSY_KEYBOARD,
    };
  }
  await promptSession(r, "queue", text, undefined);
  return null;
}

async function cmdQueue(r) {
  const sessionId = await r.state.resolveSessionId(r.chatId, "");
  if (!sessionId) return "No chat is open — tap 💬 New chat first.";
  const agent = r.ctx.get("agents")?.get(sessionId);
  const nextTurn = agent?.inbox?.state?.["next-turn"] ?? [];
  const nextStep = agent?.inbox?.state?.["next-step"] ?? [];
  const items = [
    ...nextTurn.map((m) => ({ id: m.id, kind: "queued", text: contentText(m.content) })),
    ...nextStep.map((m) => ({ id: m.id, kind: "steering", text: contentText(m.content) })),
  ];
  if (items.length === 0) return "Nothing is queued — the AI is idle. Just send a message!";
  const cs = r.state.chatState(r.chatId);
  cs.queueIds = items.map((item) => item.id);
  cs.queueListAt = Date.now();
  r.state.saveState();
  const lines = ["📥 <b>Queued messages</b>\n─────── ⋆⋅☆⋅⋆ ───────"];
  items.forEach((item, index) => {
    const tag = item.kind === "steering" ? "⚡steering" : "⏳queued";
    lines.push((index + 1) + ". <small>" + tag + "</small> " + esc(truncate(item.text, 90)));
  });
  lines.push(
    "─────── ⋆⋅☆⋅⋆ ───────",
    "▶ <code>/steer &lt;n&gt;</code> — push into the running turn",
    "✏ <code>/edit &lt;n&gt; &lt;new&gt;</code> · 🗑 <code>/remove &lt;n&gt;</code>",
  );
  return truncate(lines.join("\n"), 3000);
}

function queueItemId(r, arg) {
  const cs = r.state.chatState(r.chatId);
  if (/^\d+$/.test(arg) && cs.queueIds?.length > 0 && Date.now() - (cs.queueListAt ?? 0) < 10 * 60_000) {
    return cs.queueIds[Number(arg) - 1] ?? null;
  }
  return arg;
}

async function cmdEdit(r) {
  const sessionId = await r.state.resolveSessionId(r.chatId, "");
  if (!sessionId) return "No chat is open.";
  const itemId = queueItemId(r, r.args[0] ?? "");
  const text = r.args.slice(1).join(" ");
  if (!itemId) return "/edit &lt;n&gt; &lt;new text&gt; — see /queue for numbers";
  if (!text) return "What should the queued message say instead? /edit &lt;n&gt; &lt;new text&gt;";
  await callApi(r.ctx, "sessions", "updateQueue", { sessionId, itemId, action: { kind: "edit", content: [{ type: "text", text }] } });
  return "✏️ Updated the queued message.";
}

async function cmdRemove(r) {
  const sessionId = await r.state.resolveSessionId(r.chatId, "");
  if (!sessionId) return "No chat is open.";
  const itemId = queueItemId(r, r.args[0] ?? "");
  if (!itemId) return "/remove &lt;n&gt; — see /queue for numbers";
  await callApi(r.ctx, "sessions", "updateQueue", { sessionId, itemId, action: { kind: "remove" } });
  return "🗑 Removed the queued message.";
}

async function cmdSteer(r) {
  const text = r.rest;
  if (!text) return "/steer &lt;text&gt; — steer the running turn, or /steer &lt;n&gt; for a queued message";
  // A bare number right after /queue steers that queued message into the turn.
  if (/^\d+$/.test(text) && r.state.chatState(r.chatId).queueIds?.length > 0) {
    const sessionId = await r.state.resolveSessionId(r.chatId, "");
    if (!sessionId) return "No chat is open.";
    const itemId = queueItemId(r, text);
    if (!itemId) return "That queued message is gone — /queue to refresh.";
    await callApi(r.ctx, "sessions", "updateQueue", { sessionId, itemId, action: { kind: "steer" } });
    return "✅ Steered the queued message into the running turn.";
  }
  await promptSession(r, "steer", text, undefined);
  return "▶️ Sent it straight into the AI's current turn.";
}

async function cmdSteerNow(r) {
  const cs = r.state.chatState(r.chatId);
  const text = cs.pendingText;
  if (!text) return "Nothing pending — just type your message.";
  cs.pendingText = "";
  r.state.saveState();
  await promptSession(r, "steer", text, undefined);
  return "▶️ Sent it straight into the AI's current turn.";
}

async function cmdQueueMsg(r) {
  const cs = r.state.chatState(r.chatId);
  const text = cs.pendingText;
  if (!text) return "Nothing pending — just type your message.";
  cs.pendingText = "";
  r.state.saveState();
  await promptSession(r, "queue", text, undefined);
  return "⏳ Queued — the AI will pick it up next.";
}

async function promptSession(r, mode, text, sessionArg) {
  const sessionId = await r.state.resolveSessionId(r.chatId, sessionArg);
  if (!sessionId) return "no active session — /open &lt;id&gt; or /new first";
  if (r.state.isRecentPrompt(sessionId, text)) return "duplicate prompt skipped";
  let timeZone = "UTC";
  try { timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone; } catch {}
  let result = null;
  try {
    result = await callApi(r.ctx, "sessions", "prompt", {
      sessionId,
      mode,
      content: [{ type: "text", text }],
      clientTimeZone: timeZone,
    });
  } catch (error) {
    if (error.code !== "invocation-unavailable" && error.code !== "no api surface") {
      throw error;
    }
    // api-proxy absent (base-only profiles): fall back to the live agent's
    // inbox directly (with resume), mirroring what the api-proxy does.
    result = await promptSessionDirect(r.ctx, sessionId, mode, text);
  }
  r.state.notePrompt(sessionId, text);
  // Auto-enable notifications for this session so the agent's reply arrives.
  const chatState = r.state.chatState(r.chatId);
  const notifyChanged = chatState.notify === "off";
  if (notifyChanged) {
    chatState.notify = "session";
    r.state.saveState();
  }
  if (result?.command) {
    return "⚡ command " + esc(result.command.kind) + (result.command.text ? ": " + esc(result.command.text) : "");
  }
  // No ack — the reply arrives as a normal threaded chat message.
  return null;
}

/** Direct agent-inbox prompt for profiles without the web api-proxy. */
async function promptSessionDirect(ctx, sessionId, mode, text) {
  const agents = ctx.get("agents");
  if (!agents) throw new Error("no agent service mounted");
  let agent = agents.get(sessionId);
  if (!agent && typeof agents.resume === "function") {
    // Session not attached after a harness restart: resume it like the
    // api-proxy would (seed model from the agent-default-model service).
    let agentOptions = {};
    try {
      const modelService = ctx.get("agentDefaultModel");
      const selection = modelService?.currentSelection?.();
      if (selection?.provider && selection?.model) {
        agentOptions = {
          provider: selection.provider,
          model: selection.model,
          ...(selection.reasoningEffort ? { reasoningEffort: selection.reasoningEffort } : {}),
        };
      }
    } catch {}
    const resumed = await agents.resume({ resumeSessionId: sessionId, agentOptions });
    agent = resumed?.agent;
  }
  if (!agent) throw new Error("session has no live agent (not attached)");
  const message = {
    id: randomUUID(),
    role: "user",
    content: [{ type: "text", text }],
    source: { kind: "user" },
  };
  if (mode === "steer") {
    if (typeof agent.steer !== "function") throw new Error("agent does not accept steering");
    agent.steer(message);
  } else if (typeof agent.followup === "function") {
    agent.followup(message);
  } else {
    throw new Error("agent does not accept followups");
  }
  return { accepted: true };
}

async function cmdStop(r) {
  const sessionId = await r.state.resolveSessionId(r.chatId, r.args[0]);
  if (!sessionId) return "no active session";
  await callApi(r.ctx, "sessions", "cancel", { sessionId });
  return "⏹ cancel requested for <code>" + shortId(sessionId) + "</code>";
}

async function cmdJobs(r) {
  const jobs = await collectJobs(r.ctx);
  if (jobs.length === 0) return "no background jobs";
  return jobs
    .map((job) => {
      const icon = job.status === "running" ? "🏃" : job.status === "stopping" ? "⏳" : job.status === "completed" ? "✅" : job.status === "killed" ? "⏹" : "❌";
      const detail = job.detail ? " — " + esc(job.detail) : "";
      return icon + " <code>" + esc(job.id) + "</code> " + esc(job.label) + " [" + job.status + "]" + detail + " (" + fmtAge(job.startedAt) + ")";
    })
    .join("\n");
}

async function cmdKill(r) {
  const jobId = r.args[0];
  if (!jobId) return "/kill &lt;jobId&gt;";
  const jobs = r.ctx.get("jobs");
  const agents = r.ctx.get("agents");
  const sessions = r.ctx.get("sessions");
  for (const session of sessions.list()) {
    const agent = agents.get(session.id);
    if (!agent) continue;
    try {
      const found = jobs.list(agent).find((job) => job.id === jobId);
      if (found) {
        const outcome = jobs.kill(jobId, agent, "killed from telegram remote");
        return "⏹ " + esc(jobId) + ": " + outcome;
      }
    } catch (error) {
      if (/not found|no such/i.test(error.message)) continue;
      throw error;
    }
  }
  return "job not found: " + esc(jobId) + " (use /jobs)";
}

export async function getGoal(ctx, state, chatId) {
  const goals = ctx.get("goals");
  if (!goals) return null;
  const agents = ctx.get("agents");
  const sessionId = await state.resolveSessionId(chatId, "");
  if (!sessionId) return null;
  const agent = agents.get(sessionId);
  if (!agent) return null;
  try {
    return goals.get(agent) ?? null;
  } catch {
    return null;
  }
}

async function cmdGoal(r) {
  const goals = r.ctx.get("goals");
  const agents = r.ctx.get("agents");
  if (!goals || !agents) return "goal service unavailable";
  const sessionId = await r.state.resolveSessionId(r.chatId, "");
  if (!sessionId) return "no active session — /open &lt;id&gt; first";
  const agent = agents.get(sessionId);
  if (!agent) return "session " + shortId(sessionId) + " has no live agent";
  const action = r.args[0] ?? "get";
  try {
    switch (action) {
      case "get":
      case "status": {
        const goal = goals.get(agent);
        if (!goal) return "no active goal for this session";
        let text = "<b>Goal</b> " + goal.id + "\nphase <code>" + goal.phase + "</code> · rounds " + goal.roundsStarted + "/" + goal.maxGoalRounds + "\nrevision " + goal.revision + "\n\n" + esc(goal.objective);
        if (goal.blockedReason?.message) text += "\n\n<b>blocked:</b> " + esc(goal.blockedReason.message);
        return text;
      }
      case "create": {
        const objective = r.rest.replace(/^create\s+/, "").trim();
        if (!objective) return "/goal create &lt;objective&gt;";
        const ref = goals.create(agent, { objective });
        return "goal created: <code>" + ref.id + "</code> r" + ref.revision;
      }
      case "pause": {
        const goal = goals.get(agent);
        if (!goal) return "no active goal";
        const ref = goals.pause(agent, { id: goal.id, revision: goal.revision });
        return "⏸ paused <code>" + ref.id + "</code> r" + ref.revision;
      }
      case "resume": {
        const goal = goals.get(agent);
        if (!goal) return "no active goal";
        const ref = goals.resume(agent, { id: goal.id, revision: goal.revision });
        return "▶ resumed <code>" + ref.id + "</code> r" + ref.revision;
      }
      case "complete": {
        const goal = goals.get(agent);
        if (!goal) return "no active goal";
        const ref = goals.complete(agent, { id: goal.id, revision: goal.revision });
        return "✅ completed <code>" + ref.id + "</code> r" + ref.revision;
      }
      case "blocked": {
        const reason = r.rest.replace(/^blocked\s+/, "").trim();
        if (!reason) return "/goal blocked &lt;reason&gt;";
        const goal = goals.get(agent);
        if (!goal) return "no active goal";
        const ref = goals.blocked(agent, { id: goal.id, revision: goal.revision }, reason);
        return "⛔ marked blocked <code>" + ref.id + "</code>";
      }
      case "clear": {
        if (typeof goals.clear === "function") {
          goals.clear(agent);
        } else {
          await callApi(r.ctx, "goals", "clear", { sessionId });
        }
        return "🧹 Goal cleared.";
      }
      default:
        return "unknown action: get|create|pause|resume|complete|blocked|clear";
    }
  } catch (error) {
    return "goal error: " + esc(error.message);
  }
}

async function cmdAgents(r) {
  const sessionId = await r.state.resolveSessionId(r.chatId, r.args[0]);
  if (!sessionId) return "no active session — /open &lt;id&gt; first";
  const result = await callApi(r.ctx, "subagents", "list", { parentSessionId: sessionId });
  const entries = result?.entries ?? [];
  if (entries.length === 0) return "no subagents under " + shortId(sessionId);
  return entries
    .map((entry) => {
      if (entry.kind === "diagnostic") return "⚠ <code>" + entry.id + "</code> diagnostic " + entry.reason;
      const icon = entry.activity === "running" ? "🏃" : "💤";
      return icon + " <code>" + entry.id + "</code> " + esc(entry.label ?? "") + " [" + entry.mode + "]" + (entry.hasChildren ? " ⊳" : "");
    })
    .join("\n");
}

async function cmdSubagentSend(r) {
  const childId = r.args[0];
  const text = r.args.slice(1).join(" ");
  if (!childId || !text) return "/send &lt;agentId&gt; &lt;text&gt;";
  const sessionId = await r.state.resolveSessionId(r.chatId, "");
  if (!sessionId) return "no active parent session — /open &lt;id&gt; first";
  const result = await callApi(r.ctx, "subagents", "prompt", {
    parentSessionId: sessionId,
    childSessionId: childId,
    content: [{ type: "text", text }],
  });
  return "📨 delivered to <code>" + shortId(childId) + "</code> (message " + esc(result?.messageId ?? "?") + ")";
}

async function cmdShell(r) {
  const shell = r.ctx.get("shell");
  if (!shell) return "shell service unavailable";
  const command = r.rest;
  if (!command) return "/cmd &lt;powershell&gt;";
  let timeoutMs = 60_000;
  if (/^\d+$/.test(r.args[0] ?? "")) timeoutMs = Math.min(Math.max(Number(r.args[0]), 5_000), 300_000);
  const request = {
    command,
    workdir: r.state.config.workspaceRoot || process.cwd(),
    timeoutMs,
    stdoutMaxBytes: r.state.config.maxOutputBytes,
  };
  const spec = typeof shell.resolve === "function" ? shell.resolve(request) : request;
  const result = await shell.run(spec);
  const out = truncate(result.stdout?.text ?? "", 3500);
  const err = truncate(result.stderr?.text ?? "", 1500);
  const meta = [];
  if (result.exitCode != null) meta.push("exit code " + result.exitCode);
  if (result.signal) meta.push("signal " + result.signal);
  if (result.timedOut) meta.push("timed out");
  if (result.sandbox?.denied) meta.push("sandbox denied (" + result.sandbox.mode + ")");
  const parts = [];
  if (out) parts.push("<pre>" + esc(out) + "</pre>");
  if (err) parts.push("<pre>" + esc(err) + "</pre>");
  parts.push(meta.length ? "<i>" + esc(meta.join(" · ")) + "</i>" : "<i>ok</i>");
  return parts.join("\n");
}

async function cmdFs(r) {
  const fs = r.ctx.get("fs");
  if (!fs) return "fs service unavailable";
  const sub = (r.args[0] ?? "ls").toLowerCase();
  const action = sub;
  const restArgs = r.args.slice(1);
  const cwd = r.state.config.workspaceRoot || process.cwd();
  switch (action) {
    case "ls":
    case "list": {
      const rawPath = restArgs.join(" ").trim() || ".";
      const target = await fs.resolve(isAbsolute(rawPath) ? rawPath : resolve(cwd, rawPath), { cwd });
      const entries = await fs.listDir(target);
      const dirs = entries.filter((entry) => entry.type === "directory");
      const files = entries.filter((entry) => entry.type !== "directory");
      const lines = [
        "<b>" + esc(target.displayPath ?? rawPath) + "</b> — " + dirs.length + " dirs, " + files.length + " files",
        ...dirs.map((entry) => "📁 " + esc(entry.name)),
        ...files.map((entry) => "📄 " + esc(entry.name) + (entry.size != null ? " (" + entry.size + " B)" : "")),
      ];
      return truncate(lines.join("\n"), 3500);
    }
    case "read":
    case "cat": {
      const rawPath = restArgs.join(" ").trim();
      if (!rawPath) return "/fs read &lt;path&gt;";
      const target = await fs.resolve(isAbsolute(rawPath) ? rawPath : resolve(cwd, rawPath), { cwd });
      const stat = await fs.stat(target);
      if (!stat) return "not found: " + esc(target.displayPath ?? rawPath);
      if (stat.type !== "file") return "not a file: " + esc(target.displayPath ?? rawPath);
      const text = await fs.readText(target);
      return "<b>" + esc(target.displayPath ?? rawPath) + "</b> (" + stat.size + " B)\n<pre>" + esc(truncate(text, 3500)) + "</pre>";
    }
    case "write": {
      const sep = restArgs.indexOf("|");
      if (sep < 0) return "/fs write &lt;path&gt; | &lt;content&gt; — content after the pipe";
      const path = restArgs.slice(0, sep).join(" ").trim();
      const content = restArgs.slice(sep + 1).join(" ");
      const target = await fs.resolve(isAbsolute(path) ? path : resolve(cwd, path), { cwd });
      const outcome = await fs.writeText(target, content);
      return "✍ " + outcome.operation + " " + esc(target.displayPath) + " (v" + outcome.version + ")";
    }
    case "rm":
    case "del": {
      const rawPath = restArgs.join(" ").trim();
      if (!rawPath) return "/fs rm &lt;path&gt;";
      const target = await fs.resolve(isAbsolute(rawPath) ? rawPath : resolve(cwd, rawPath), { cwd });
      try {
        await fs.delete(target);
        return "🗑 deleted " + esc(target.displayPath ?? rawPath);
      } catch (error) {
        return "delete failed: " + esc(error.message);
      }
    }
    case "stat": {
      const rawPath = restArgs.join(" ").trim();
      if (!rawPath) return "/fs stat &lt;path&gt;";
      const target = await fs.resolve(isAbsolute(rawPath) ? rawPath : resolve(cwd, rawPath), { cwd });
      const stat = await fs.stat(target);
      if (!stat) return "not found: " + esc(target.displayPath ?? rawPath);
      return "<b>" + esc(target.displayPath ?? rawPath) + "</b>\ntype " + stat.type + " · size " + stat.size + " B · version " + esc(stat.version);
    }
    default:
      return "usage: /fs ls|read|write|rm|stat &lt;path&gt;";
  }
}

async function cmdLog(r) {
  const sessions = r.ctx.get("sessions");
  const sessionQuery = r.ctx.get("sessionQuery");
  let sessionId = r.args[0] ?? "";
  let count = 8;
  if (/^\d+$/.test(sessionId)) {
    count = Number(sessionId);
    sessionId = "";
  }
  if (sessionId && /^\d+$/.test(r.args[1] ?? "")) count = Number(r.args[1]);
  sessionId = await r.state.resolveSessionId(r.chatId, sessionId);
  if (!sessionId) return "no active session — /open &lt;id&gt; first";
  let events;
  try {
    const live = sessions.get(sessionId);
    if (live) {
      events = live.events;
    } else if (sessionQuery && typeof sessionQuery.readSession === "function") {
      const loaded = await sessionQuery.readSession(sessionId);
      events = loaded.events;
    } else if (sessionQuery && typeof sessionQuery.load === "function") {
      const loaded = await sessionQuery.load(sessionId);
      events = loaded.events;
    } else {
      return "session " + shortId(sessionId) + " not attached and sessionQuery unavailable";
    }
  } catch (error) {
    return "load failed: " + esc(error.message);
  }
  const shown = [];
  for (const event of events) {
    if (event.type === "user/message") {
      const text = contentText(event.data.content);
      if (text) shown.push("🧑 " + esc(truncate(text, 300)));
    } else if (event.type === "assistant/message") {
      const text = contentText(event.data.message?.content, { textOnly: true });
      if (text) shown.push("🤖 " + esc(truncate(text, 500)));
    } else if (event.type === "tool/call") {
      shown.push("🔧 " + esc(event.data.name) + " " + esc(truncate(String(event.data.arguments ?? ""), 120)));
    } else if (event.type === "tool/result" && event.data.error) {
      shown.push("⚠ " + esc(event.data.error.name ?? "error") + ": " + esc(truncate(String(event.data.error.message ?? ""), 160)));
    } else if (event.type === "turn/end") {
      shown.push("⏹ turn ended: " + esc(event.data.reason?.kind ?? "?"));
    }
  }
  if (shown.length === 0) return "<code>" + sessionId + "</code> — no surface events";
  const tail = shown.slice(-count).join("\n");
  return "<b>" + esc(sessionId) + "</b> (last " + Math.min(count, shown.length) + " of " + shown.length + ")\n" + tail;
}

async function cmdRaw(r) {
  const endpoint = r.args[0] ?? "";
  const [namespace, method] = endpoint.includes(".") ? endpoint.split(".") : endpoint.split("/");
  if (!namespace || !method) return "/raw &lt;namespace.method&gt; [json args]";
  let args = {};
  const jsonPart = r.rest.replace(endpoint, "").trim();
  if (jsonPart) {
    try {
      args = JSON.parse(jsonPart);
    } catch (error) {
      return "invalid JSON args: " + esc(error.message);
    }
  }
  let result;
  try {
    result = await callApi(r.ctx, namespace, method, args);
  } catch (error) {
    if (error.code !== "no api surface") throw error;
    const gateway = r.ctx.get("typertGateway");
    if (!gateway) throw new Error("no api surface for " + endpoint);
    result = await invoke(gateway, namespace, method, args);
  }
  return "<b>" + esc(endpoint) + "</b> →\n<pre>" + esc(pretty(result, 3500)) + "</pre>";
}

async function cmdApi(r) {
  const gateway = r.ctx.get("typertGateway");
  const typert = r.ctx.get("typert");
  const endpoints = new Set();
  try {
    const local = typert?.local;
    if (local) {
      if (typeof local.keys === "function") for (const key of local.keys()) endpoints.add(key);
      if (local instanceof Map) for (const key of local.keys()) endpoints.add(key);
    }
  } catch {}
  try {
    if (typeof gateway?.collectSrcClaims === "function") {
      for (const claim of gateway.collectSrcClaims()) endpoints.add(claim);
    }
  } catch {}
  if (endpoints.size === 0) return "no endpoints discovered";
  const sorted = [...endpoints].sort();
  return "<b>" + endpoints.size + " endpoints</b>\n<code>" + esc(sorted.join("\n")) + "</code>".slice(0, 3900);
}

async function cmdEval(r) {
  if (!r.state.config.allowEval) return "/eval disabled (allowEval=false)";
  const code = r.rest;
  if (!code) return "/eval &lt;js&gt; — runs with ctx, state, gateway, jobs, fs, shell, sessions, agents, goals in scope";
  const sandbox = {
    ctx: r.ctx,
    state: r.state,
    gateway: r.ctx.get("typertGateway"),
    apiProxy: r.ctx.get("apiProxy"),
    callApi: (domain, method, args) => callApi(r.ctx, domain, method, args),
    jobs: r.ctx.get("jobs"),
    fs: r.ctx.get("fs"),
    shell: r.ctx.get("shell"),
    sessions: r.ctx.get("sessions"),
    agents: r.ctx.get("agents"),
    goals: r.ctx.get("goals"),
    settings: r.ctx.get("settings"),
    process,
  };
  const fn = new Function(...Object.keys(sandbox), "return (async () => {\n" + code + "\n})()");
  const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error("eval timeout (30s)")), 30_000));
  const result = await Promise.race([fn(...Object.values(sandbox)), timeout]);
  return "<pre>" + esc(pretty(result, 3000)) + "</pre>";
}

async function cmdConfig(r) {
  const parts = [];
  for (const file of [join(dshHome(), "settings.yaml"), join(dshHome(), "profiles", "web", "cordis.patch.yml")]) {
    if (!existsSync(file)) continue;
    try {
      const text = readFileSync(file, "utf8");
      parts.push("<b>" + esc(file.replace(dshHome(), "~")) + "</b>\n<pre>" + esc(truncate(text, 2500)) + "</pre>");
    } catch (error) {
      parts.push("<b>" + esc(file) + "</b> — read failed: " + esc(error.message));
    }
  }
  if (parts.length === 0) return "no config files found";
  return parts.join("\n");
}

async function cmdNotify(r) {
  const state = r.state.chatState(r.chatId);
  const arg = (r.args[0] ?? "").toLowerCase();
  const modes = {
    on: "session — replies of this chat's session",
    all: "all — every session's activity",
    off: "off — nothing until you ask",
  };
  if (arg === "on" || arg === "all" || arg === "off") {
    state.notify = arg;
    r.state.saveState();
    return "🔔 <b>Notify:</b> <code>" + arg + "</code>\n<small>" + modes[arg] + "</small>";
  }
  if (arg === "status") {
    return "🔔 <b>Notify:</b> <code>" + state.notify + "</code>" + (state.sessionId ? " <small>(active session " + shortId(state.sessionId) + ")</small>" : "");
  }
  return "🔔 <b>Notify</b>\n<code>/notify on</code> — this chat's session\n<code>/notify all</code> — everything\n<code>/notify off</code> — silence";
}

async function cmdReboot(r) {
  const yes = r.args.includes("--yes") || r.args.includes("yes");
  if (!yes) return "/reboot --yes — this restarts the whole harness process";
  const launched = await launchRestart(r.state);
  if (!launched.ok) {
    r.state.log("restart failed to launch: " + launched.error);
    return "❌ restart failed to launch: " + esc(launched.error);
  }
  await r.state.bot.send(r.chatId, "🔄 restarting harness (pid " + process.pid + ")… bot will re-appear in ~20s");
  r.state.log("/reboot by " + r.userId);
  // Fallback: if the killer script somehow fails, exit anyway after a grace
  // period (the detached script relaunches the harness either way).
  setTimeout(() => {
    try { process.exit(0); } catch {}
  }, 15_000);
  return null;
}

/**
 * Write and spawn the detached restart script. Resolves with
 * { ok: true } only when the child process actually started; spawn errors
 * (missing shell, sandbox denial, …) resolve with { ok: false, error }.
 */
async function launchRestart(state) {
  try {
    writeRestartScript(state);
    const pwshPath = resolvePwsh();
    const child = spawn(pwshPath, ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", state.restartScriptPath], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    const failed = await new Promise((resolve) => {
      child.once("error", (error) => resolve(error));
      // The child outlives us (detached); after 2s treat it as started.
      setTimeout(() => resolve(null), 2_000);
    });
    if (failed) return { ok: false, error: failed.message };
    child.unref();
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

async function cmdShutdown(r) {
  const yes = r.args.includes("--yes") || r.args.includes("yes");
  if (!yes) return "/shutdown --yes — stops the whole harness process";
  r.state.log("/shutdown by " + r.userId);
  await r.state.bot.send(r.chatId, "⏻ shutting down harness…");
  setTimeout(() => {
    try { process.exit(0); } catch {}
  }, 2_000);
  return null;
}

/* ── reboot helpers ── */

function resolvePwsh() {
  const candidates = [
    join(process.env.ProgramFiles ?? "C:\\Program Files", "PowerShell", "7", "pwsh.exe"),
    join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
  ];
  for (const candidate of candidates) if (existsSync(candidate)) return candidate;
  return "powershell.exe";
}

function resolveNpx() {
  const candidates = [
    join(dirname(process.execPath), "npx.cmd"),
    join(process.env.APPDATA ?? "", "npm", "npx.cmd"),
  ];
  for (const candidate of candidates) if (existsSync(candidate)) return candidate;
  return "npx";
}

export function writeRestartScript(state) {
  // Relaunch from the SAME directory the harness was originally launched
  // from (process.cwd()), NOT the workspace root. The launch directory
  // decides which .env layers dsh loads, and a workspace .env may carry
  // reserved vars (e.g. DSH_MAX_TOKENS) that make boot crash when loaded.
  const cwd = process.cwd();
  const npx = resolveNpx();
  const log = join(dshHome(), "telegram-remote-restart.log");
  const outLog = join(dshHome(), "dsh-web.out.log");
  const errLog = join(dshHome(), "dsh-web.err.log");
  const pid = process.pid;
  const ppid = process.ppid;
  // Detect the port THIS harness was launched with so /reboot stays on it
  // (default 3080). Never kill other dsh instances the user may be running.
  let port = 3080;
  const portIdx = process.argv.findIndex((a) => a === "--port" || a === "-p");
  if (portIdx >= 0 && process.argv[portIdx + 1]) port = Number(process.argv[portIdx + 1]) || 3080;
  const script = [
    '$log = ' + "'" + log + "'",
    'Add-Content $log "restart: killing harness (pid ' + pid + ', ppid ' + ppid + ') on port ' + port + ' at $(Get-Date)"',
    'Start-Sleep -Seconds 3',
    // Graceful first: SIGINT lets the harness checkpoint the session logs
    // cleanly (no mid-write corruption). Force-kill only as a fallback.
    'Add-Content $log "sending graceful SIGINT to ' + pid + '"',
    "& 'C:\\nvm4w\\nodejs\\node.exe' -e \"process.kill(" + pid + ", 'SIGINT')\" 2>\$null",
    'for ($i = 0; $i -lt 20; $i++) {',
    '  Start-Sleep -Seconds 1',
    '  if (-not (Get-Process -Id ' + pid + ' -ErrorAction SilentlyContinue)) { Add-Content $log ("exited gracefully after " + ($i + 1) + "s"); break }',
    '}',
    'foreach ($p in @(' + pid + ', ' + ppid + ')) {',
    '  if (Get-Process -Id $p -ErrorAction SilentlyContinue) {',
    '    try { Stop-Process -Id $p -Force -ErrorAction Stop; Add-Content $log ("force-killed " + $p) } catch { Add-Content $log ("kill failed " + $p) }',
    '  }',
    '}',
    'Start-Sleep -Seconds 2',
    'Add-Content $log "relaunching npx=' + npx + " cwd=" + cwd + " port=" + port + ' at $(Get-Date)"',
    "Start-Process -FilePath '" + npx + "' -ArgumentList '@deepseek-ai/dsh','web','--port','" + port + "' -WorkingDirectory '" + cwd + "' -WindowStyle Hidden -RedirectStandardOutput '" + outLog + "' -RedirectStandardError '" + errLog + "'",
    "for ($i = 0; $i -lt 90; $i++) {",
    "  Start-Sleep -Seconds 2",
    "  try {",
    "    $r = Invoke-WebRequest -Uri 'http://127.0.0.1:" + port + "' -UseBasicParsing -TimeoutSec 3",
    '    Add-Content $log ("UP status=" + $r.StatusCode + " at " + (Get-Date))',
    "    exit 0",
    "  } catch {}",
    "}",
    'Add-Content $log ("FAILED: harness did not come up at " + (Get-Date))',
    "exit 1",
  ].join("\r\n");
  writeFileSync(state.restartScriptPath, script, "utf8");
}
