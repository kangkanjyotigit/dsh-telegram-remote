/**
 * Full-harness feature commands: sessions, workspaces, subagents, presets,
 * skills, plugins, settings, credentials, permissions, exports.
 */

import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { esc } from "./bot.js";
import { callApi, contentText, dshHome, fmtAge, pretty, shortId, truncate } from "./util.js";

/* ── session management ── */

export async function cmdRename(r) {
  const sessionId = await r.state.resolveSessionId(r.chatId, r.args[0]);
  const title = r.args.slice(1).join(" ").trim();
  if (!sessionId || !title) return "/rename <chat> <new title> — e.g. /rename 1 my todo app";
  const result = await callApi(r.ctx, "sessions", "rename", { sessionId, title });
  return "✏️ Renamed to <b>" + esc(result.title) + "</b>";
}

export async function cmdFork(r) {
  const sessionId = await r.state.resolveSessionId(r.chatId, r.args[0]);
  if (!sessionId) return "/fork <chat> — makes a copy you can experiment on";
  const result = await callApi(r.ctx, "sessions", "fork", { sessionId });
  const newId = result.sessionId;
  r.state.chatState(r.chatId).sessionId = newId;
  r.state.saveState();
  return "🍴 Forked! New chat: <code>" + newId + "</code>\nIt's now your active chat.";
}

export async function cmdSearch(r) {
  const query = r.rest;
  if (!query) return "/search <text> — find a past conversation";
  const result = await callApi(r.ctx, "sessions", "search", { query });
  const items = result?.items ?? [];
  if (!items.length) return "Nothing found for \"" + esc(query) + "\"";
  const lines = items.slice(0, 10).map((it) => "• <code>" + shortId(it.sessionId) + "</code> " + esc(truncate(it.snippet, 140)));
  if (result.hasMore) lines.push("…more matches");
  return lines.join("\n");
}

export async function cmdExport(r) {
  const sessionId = await r.state.resolveSessionId(r.chatId, r.args[0]);
  if (!sessionId) return "/export <chat> — download the full conversation as a file";
  const api = r.ctx.get("apiProxy");
  if (!api?.downloads?.sessionLog) return "Export is unavailable in this deployment.";
  await r.state.bot.send(r.chatId, "📦 Preparing export…");
  const response = await api.downloads.sessionLog({ rpcId: "exp-" + Math.random().toString(36).slice(2, 8), payload: { sessionId } });
  if (!response || !response.ok) {
    const body = await response?.text?.().catch(() => "");
    throw new Error("export failed: " + (body || "unknown"));
  }
  const buf = Buffer.from(await response.arrayBuffer());
  const filename = "dsh-session-" + sessionId.replace(/^session-/, "").slice(0, 8) + ".zip";
  const path = join(dshHome(), filename);
  writeFileSync(path, buf);
  await r.state.bot.sendDocument(r.chatId, buf, filename, "📦 Full conversation export (" + (buf.length / 1024).toFixed(1) + " KB)");
  return null;
}

/* ── workspaces ── */

export async function cmdWorkspaces(r) {
  const result = await callApi(r.ctx, "workspace", "list", {});
  const items = result?.items ?? [];
  const archived = result?.archivedSessionIds ?? [];
  if (!items.length) return "No workspaces yet — /ws new <folder>";
  const lines = ["<b>Workspaces</b> — folders your chats live in"];
  items.forEach((w, i) => {
    const ts = typeof w.updatedAt === "number" ? w.updatedAt : Date.parse(String(w.updatedAt ?? ""));
    lines.push((i + 1) + ". " + esc(w.title || w.path) + " — " + (w.sessionIds?.length ?? 0) + " chats\n   " + esc(w.path) + (isNaN(ts) ? "" : " · " + fmtAge(ts)));
  });
  if (archived.length) lines.push("\n🗄 " + archived.length + " archived chat(s)");
  lines.push("", "/ws new <folder> to add one");
  return truncate(lines.join("\n"), 3000);
}

export async function cmdWs(r) {
  const action = (r.args[0] ?? "new").toLowerCase();
  const rest = r.args.slice(1);
  if (action === "new" || action === "create") {
    const path = rest.join(" ").trim();
    if (!path) return "/ws new <folder path> — e.g. /ws new C:\\projects\\myapp";
    const result = await callApi(r.ctx, "workspace", "create", { path });
    return "📁 Workspace " + (result.created ? "created" : "already existed") + ": <b>" + esc(result.workspace?.title || result.workspace?.path || path) + "</b>";
  }
  const list = await callApi(r.ctx, "workspace", "list", {});
  const items = list?.items ?? [];
  if (action === "rename") {
    const n = Number(rest[0]);
    const title = rest.slice(1).join(" ").trim();
    const ws = items[n - 1];
    if (!ws || !title) return "/ws rename <n> <new title> — see /workspaces";
    await callApi(r.ctx, "workspace", "rename", { workspaceId: ws.id, title });
    return "✏️ Workspace renamed to <b>" + esc(title) + "</b>";
  }
  if (action === "delete" || action === "rm") {
    const n = Number(rest[0]);
    const ws = items[n - 1];
    if (!ws) return "/ws delete <n> — see /workspaces";
    await callApi(r.ctx, "workspace", "delete", { workspaceId: ws.id });
    return "🗑 Workspace deleted: " + esc(ws.title || ws.path);
  }
  return "/ws new <path> · /ws rename <n> <title> · /ws delete <n>";
}

export async function cmdMkdir(r) {
  const path = r.rest.trim();
  if (!path) return "/mkdir <path> — create a folder";
  const parts = path.split(/[\\/]+/).filter(Boolean);
  const name = parts.pop();
  const parent = parts.join("\\") || "C:\\";
  await callApi(r.ctx, "host", "createDirectory", { path: parent, name });
  return "📁 Created " + esc(path);
}

export async function cmdArchive(r) {
  const sessionId = await r.state.resolveSessionId(r.chatId, r.args[0]);
  if (!sessionId) return "/archive <chat> — tuck it away (stays saved)";
  const result = await callApi(r.ctx, "workspace", "archiveSession", { sessionId });
  return "🗄 Archived <code>" + shortId(sessionId) + "</code> — " + (result.archivedSessionIds?.length ?? 0) + " archived total.";
}

/* ── subagents deep ── */

export async function cmdInterrupt(r) {
  const childId = r.args[0];
  const sessionId = await r.state.resolveSessionId(r.chatId, "");
  if (!childId || !sessionId) return "/interrupt <agentId> — see /agents";
  await callApi(r.ctx, "subagents", "interrupt", { parentSessionId: sessionId, childSessionId: childId, mode: "continuable" });
  return "⏹ Interrupted <code>" + shortId(childId) + "</code>";
}

export async function cmdAgentLog(r) {
  const childId = r.args[0];
  const sessionId = await r.state.resolveSessionId(r.chatId, "");
  let count = 10;
  if (/^\d+$/.test(r.args[1] ?? "")) count = Number(r.args[1]);
  if (!childId || !sessionId) return "/agentlog <agentId> [n] — see /agents";
  const result = await callApi(r.ctx, "subagents", "history", {
    parentSessionId: sessionId,
    childSessionId: childId,
    mode: "continuable",
    maxMessages: count,
  });
  const events = result?.events ?? [];
  const shown = [];
  for (const entry of events) {
    const ev = entry?.event ?? entry;
    if (ev.type === "user/message") {
      const t = contentText(ev.data?.content);
      if (t) shown.push("🧑 " + esc(truncate(t, 260)));
    } else if (ev.type === "assistant/message") {
      const t = contentText(ev.data?.message?.content, { textOnly: true });
      if (t) shown.push("🤖 " + esc(truncate(t, 420)));
    } else if (ev.type === "tool/call") {
      shown.push("🔧 " + esc(ev.data?.name ?? "?"));
    }
  }
  if (!shown.length) return "<code>" + shortId(childId) + "</code> — no surface messages";
  return "<b>" + esc(shortId(childId)) + "</b> (last " + Math.min(count, shown.length) + ")\n" + shown.slice(-count).join("\n");
}

/* ── presets / skills / plugins ── */

export async function cmdPresets(r) {
  const result = await callApi(r.ctx, "agentPresets", "list", {});
  const items = result?.items ?? [];
  if (!items.length) return "No agent presets available.";
  const lines = ["<b>Agent presets</b> — /preset <name> switches this chat"];
  items.forEach((p) => {
    lines.push("• <code>" + esc(p.id) + "</code>" + (p.isDefault ? " (default)" : "") + (p.name ? " — " + esc(p.name) : "") + " [" + p.trust + "]");
  });
  return truncate(lines.join("\n"), 2500);
}

export async function cmdPreset(r) {
  const preset = r.args[0];
  const sessionId = await r.state.resolveSessionId(r.chatId, "");
  if (!preset || !sessionId) return "/preset <name> — see /presets";
  const result = await callApi(r.ctx, "agentPresets", "select", { sessionId, agentPreset: preset });
  return "✅ This chat now uses preset <b>" + esc(result.agentPreset) + "</b>";
}

export async function cmdSkills(r) {
  const sessionId = await r.state.resolveSessionId(r.chatId, "");
  if (!sessionId) return "Open a chat first, then /skills.";
  const result = await callApi(r.ctx, "skills", "list", { sessionId });
  const skills = result?.skills ?? [];
  if (!skills.length) return "No skills available for this chat.";
  return skills.slice(0, 20).map((s) => "• <code>" + esc(s.name) + "</code>" + (s.description ? " — " + esc(truncate(s.description, 90)) : "")).join("\n");
}

export async function cmdPlugins(r) {
  const gateway = r.ctx.get("typertGateway");
  if (!gateway) return "Unavailable in this deployment.";
  const { invoke } = await import("./util.js");
  let result;
  try {
    result = await invoke(gateway, "pluginInventory", "query", {});
  } catch (error) {
    if (error.code !== "invocation-unavailable") throw error;
    result = await invoke(gateway, "pluginInventory", "list", {});
  }
  const entries = Array.isArray(result) ? result : (result?.entries ?? result?.plugins ?? []);
  if (!entries.length) return "No plugin inventory available.";
  return entries.slice(0, 25).map((p) => "• <code>" + esc(p.id ?? p.name ?? "?") + "</code>" + (p.disabled ? " (disabled)" : "")).join("\n");
}

/* ── settings / credentials / permissions ── */

export async function cmdSettings(r) {
  const result = await callApi(r.ctx, "settings", "describe", {});
  const namespaces = result?.namespaces ?? [];
  if (!namespaces.length) return "No settings sections exposed.";
  const lines = ["<b>Settings</b> — /setting <ns> <json> to change one"];
  namespaces.forEach((ns) => lines.push("• <code>" + esc(ns.ns) + "</code>"));
  return truncate(lines.join("\n"), 2500);
}

export async function cmdSetting(r) {
  const ns = r.args[0];
  const json = r.rest.replace(ns, "").trim();
  if (!ns || !json) return "/setting <ns> <json> — e.g. /setting ui-theme {\"preference\":\"light\"}";
  let value;
  try {
    value = JSON.parse(json);
  } catch (error) {
    return "That JSON doesn't parse: " + esc(error.message);
  }
  await callApi(r.ctx, "settings", "update", { ns, patch: value });
  return "✅ <code>" + esc(ns) + "</code> updated.";
}

export async function cmdCreds(r) {
  const [action, ref, value] = r.args;
  if (action === "set" && ref && value) {
    await callApi(r.ctx, "credentials", "set", { ref, value });
    return "✅ <code>" + esc(ref) + "</code> saved.";
  }
  if (action === "unset" && ref) {
    await callApi(r.ctx, "credentials", "unset", { ref });
    return "🗑 <code>" + esc(ref) + "</code> removed.";
  }
  const result = await callApi(r.ctx, "credentials", "describe", {
    refs: ["DEEPSEEK_API_KEY", "OPENCODE_GO_API_KEY"],
  });
  const creds = result?.credentials ?? {};
  const lines = ["<b>Credentials</b> (configured? where from)"];
  for (const [refName, view] of Object.entries(creds)) {
    lines.push("• <code>" + esc(refName) + "</code> " + (view.configured ? "✅" : "❌") + (view.source ? " (" + esc(view.source) + ")" : ""));
  }
  lines.push("", "/creds set <NAME> <value> · /creds unset <NAME>");
  return lines.join("\n");
}

export async function cmdPermission(r) {
  const sessionId = await r.state.resolveSessionId(r.chatId, "");
  const modeArg = (r.args[0] ?? "").toLowerCase();
  const modes = {
    "read-only": "read-only", ro: "read-only", read: "read-only",
    "workspace-write": "workspace-write", write: "workspace-write", workspace: "workspace-write",
    "danger-full-access": "danger-full-access", full: "danger-full-access", danger: "danger-full-access",
  };
  const mode = modes[modeArg];
  if (!sessionId) return "Open a chat first.";
  if (!mode) return "/permission read|write|full — how much of your files this chat's AI can touch";
  const session = r.ctx.get("sessions")?.get(sessionId);
  if (!session || typeof session.append !== "function") return "This chat isn't attached right now.";
  session.append("sandbox/mode", { mode });
  return "✅ This chat's AI access: <b>" + mode + "</b>";
}
