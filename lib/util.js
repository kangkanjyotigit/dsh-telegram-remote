/**
 * Shared helpers for dsh-telegram-remote.
 */

import { join } from "node:path";

export function dshHome() {
  return process.env.DSH_HOME || join(process.env.USERPROFILE || process.env.HOME || ".", ".dsh");
}

export function nowIso() {
  return new Date().toISOString();
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function truncate(text, max) {
  const str = String(text ?? "");
  if (str.length <= max) return str;
  return str.slice(0, max) + "\n…[truncated]";
}

export function pretty(value, max = 3000) {
  try {
    return truncate(JSON.stringify(value, null, 2), max);
  } catch {
    return truncate(String(value), max);
  }
}

export function fmtAge(ts) {
  if (typeof ts !== "number") return "?";
  const sec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (sec < 60) return sec + "s ago";
  if (sec < 3600) return Math.floor(sec / 60) + "m ago";
  if (sec < 86400) return Math.floor(sec / 3600) + "h ago";
  return Math.floor(sec / 86400) + "d ago";
}

export function shortId(sessionId) {
  const id = String(sessionId ?? "");
  return id.length > 12 ? id.slice(0, 8) + "…" + id.slice(-6) : id;
}

const HTML_CACHE_MAX = 64;
const htmlCache = new Map();

/** Structured markdown → Telegram-HTML renderer (memoized). */
export function markdownToHtml(md) {
  const text = String(md ?? "");
  const cached = htmlCache.get(text);
  if (cached !== undefined) return cached;
  const escape = (s) => String(s).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  const inline = (s) => s
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
    .replace(/(^|[^*])\*([^*]+)\*(?!\*)/g, "$1<i>$2</i>")
    .replace(/__([^_]+)__/g, "<u>$1</u>")
    .replace(/~~([^~]+)~~/g, "<s>$1</s>")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2">$1</a>');
  const lines = String(text).split("\n");
  const out = [];
  let inFence = false;
  let fenceLang = "";
  const fence = [];
  const flushFence = () => {
    if (!inFence) return;
    inFence = false;
    const body = fence.join("\n");
    out.push((fenceLang ? "<i>" + escape(fenceLang) + "</i>\n" : "") + "<pre>" + escape(body) + "</pre>");
    fence.length = 0;
    fenceLang = "";
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fenceMatch = line.match(/^\s*```(.*)$/);
    if (fenceMatch) {
      if (!inFence) {
        inFence = true;
        fenceLang = fenceMatch[1].trim();
      } else {
        flushFence();
      }
      continue;
    }
    if (inFence) {
      fence.push(line);
      continue;
    }
    const trimmed = line.trim();
    if (!trimmed) {
      out.push("");
      continue;
    }
    const h = trimmed.match(/^(#{1,6})\s+(.+)$/);
    if (h) {
      const prefix = h[1].length <= 2 ? "📌 " : h[1].length === 3 ? "▸ " : "• ";
      out.push("<b>" + prefix + inline(escape(h[2])) + "</b>");
      continue;
    }
    if (/^>\s?/.test(trimmed)) {
      out.push("<i>" + inline(escape(trimmed.replace(/^>\s?/, ""))) + "</i>");
      continue;
    }
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      out.push("──────────────");
      continue;
    }
    const ul = trimmed.match(/^([-*+])\s+(.+)$/);
    if (ul) {
      out.push("• " + inline(escape(ul[2])));
      continue;
    }
    const ol = trimmed.match(/^(\d+)[.)]\s+(.+)$/);
    if (ol) {
      out.push("<b>" + ol[1] + ".</b> " + inline(escape(ol[2])));
      continue;
    }
    if (trimmed.includes("-") && /^\|?[\s:-]+\|?\s*$/.test(trimmed)) {
      continue;
    }
    out.push(inline(escape(trimmed)));
  }
  flushFence();
  const result = out.join("\n");
  if (htmlCache.size >= HTML_CACHE_MAX) htmlCache.delete(htmlCache.keys().next().value);
  htmlCache.set(text, result);
  return result;
}

/** Extract readable text from a session content block array. */
export function contentText(blocks, { textOnly = false } = {}) {
  if (!Array.isArray(blocks)) return "";
  return blocks
    .map((b) => {
      if (!b || typeof b !== "object") return "";
      if (b.type === "text" && typeof b.text === "string") return b.text;
      if (b.type === "reasoning") return "";
      if (b.type === "tool-call") {
        if (textOnly) return "";
        return "[" + b.name + "] " + truncate(String(b.arguments ?? ""), 120);
      }
      if (b.type === "tool-result") return contentText(b.content, { textOnly });
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

/** True when a content block array contains at least one real text block. */
export function hasText(blocks) {
  if (!Array.isArray(blocks)) return false;
  return blocks.some((b) => b && typeof b === "object" && b.type === "text" && typeof b.text === "string" && b.text.trim().length > 0);
}

/** Gateway invocation with RPC-envelope unwrapping. */
export async function invoke(gateway, namespace, method, args = {}) {
  const result = await gateway.invoke({ namespace, method, args });
  if (result && typeof result === "object" && "ok" in result) {
    if (result.ok === true) return result.value;
    const error = result.error ?? {};
    const err = new Error(error.message ?? namespace + "." + method + " failed");
    err.code = error.code;
    throw err;
  }
  return result;
}

/**
 * Call one harness API method the way the web client does, in-process.
 * Prefers the host api-proxy service (domains: sessions, subagents, host,
 * goals, workspace, skills, agentPresets, settings, credentials, llm, ...),
 * falling back to the typert gateway (slash namespaces such as commands/*,
 * pluginInventory/*, messageFeedback/*) when the api-proxy does not mount
 * that method. Returns the unwrapped business value or throws with the
 * wire error code attached.
 */
export async function callApi(ctx, domain, method, args = {}) {
  const apiProxy = ctx.get("apiProxy");
  if (apiProxy && typeof apiProxy?.[domain]?.[method] === "function") {
    const response = await apiProxy[domain][method]({
      rpcId: "tg-" + Math.random().toString(36).slice(2, 10),
      payload: args,
    });
    const result = response?.result;
    if (result && typeof result === "object") {
      if (result.ok === true) return result.value;
      if (result.ok === false) {
        const error = result.error ?? {};
        const err = new Error(error.message ?? domain + "." + method + " failed");
        err.code = error.code;
        throw err;
      }
    }
    return result;
  }
  const gateway = ctx.get("typertGateway");
  if (gateway) return invoke(gateway, domain, method, args);
  throw new Error("no api surface for " + domain + "." + method);
}
