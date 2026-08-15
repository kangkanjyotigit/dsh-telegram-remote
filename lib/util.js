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

/** Minimal markdown → Telegram-HTML for clean agent replies (memoized). */
export function markdownToHtml(md) {
  const text = String(md ?? "");
  const cached = htmlCache.get(text);
  if (cached !== undefined) return cached;
  const escape = (s) => String(s).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  const inline = (s) => s
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
    .replace(/(^|[^*])\*([^*]+)\*(?!\*)/g, "$1<i>$2</i>")
    .replace(/__(\S(?:[^_]*\S)?)__/g, "<b>$1</b>");
  const segments = text.split(/(```[^\n]*\n[\s\S]*?```)/g);
  const out = segments.map((seg) => {
    if (/^```/.test(seg)) {
      const inner = seg.replace(/^```[^\n]*\n/, "").replace(/```\s*$/, "");
      return "<pre>" + escape(inner) + "</pre>";
    }
    return inline(escape(seg));
  }).join("");
  if (htmlCache.size >= HTML_CACHE_MAX) htmlCache.delete(htmlCache.keys().next().value);
  htmlCache.set(text, out);
  return out;
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
