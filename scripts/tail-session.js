#!/usr/bin/env node
/**
 * tail-session.js — human-readable tail of a Yoke session .jsonl log.
 *
 * Usage:
 *   node scripts/tail-session.js <path/to/session.jsonl>
 *   node scripts/tail-session.js            # picks newest log in .yoke/logs/
 *
 * Env vars (mirror make targets):
 *   PHASE=implement|review
 *   FEATURE=feat-something
 */

import { openSync, readSync, readdirSync, statSync } from "fs";
import { join } from "path";

// ── ANSI colours ─────────────────────────────────────────────────────────────
const RESET   = "\x1b[0m";
const BOLD    = "\x1b[1m";
const DIM     = "\x1b[2m";
const CYAN    = "\x1b[36m";
const YELLOW  = "\x1b[33m";
const GREEN   = "\x1b[32m";
const RED     = "\x1b[31m";
const MAGENTA = "\x1b[35m";

const c = (color, text) => `${color}${text}${RESET}`;

// ── Helpers ───────────────────────────────────────────────────────────────────
function trunc(s, n = 120) {
  s = String(s ?? "").trim().replace(/\n/g, " ↵ ");
  return s.length > n ? s.slice(0, n) + "…" : s;
}

function toolSummary(name, inp) {
  if (name === "Bash")
    return `${c(YELLOW, "Bash")}  ${c(DIM, trunc(inp.command ?? "", 90))}`;
  if (["Read", "Write", "Edit"].includes(name))
    return `${c(YELLOW, name)}  ${c(DIM, inp.file_path ?? "?")}`;
  if (name === "Glob") {
    const path = inp.path ?? "";
    return `${c(YELLOW, "Glob")}  ${inp.pattern ?? "?"}` + (path ? `  in ${c(DIM, path)}` : "");
  }
  if (name === "Grep") {
    const path = inp.path ?? "";
    return `${c(YELLOW, "Grep")}  /${inp.pattern ?? "?"}/${path ? `  in ${c(DIM, path)}` : ""}`;
  }
  if (name === "Agent") {
    const sub   = inp.subagent_type ?? "";
    const label = sub ? `Agent(${sub})` : "Agent";
    return `${c(MAGENTA, label)}  ${c(DIM, trunc(inp.description ?? "?", 80))}`;
  }
  if (name === "WebFetch")
    return `${c(YELLOW, "WebFetch")}  ${c(DIM, trunc(inp.url ?? "?", 90))}`;
  if (name === "WebSearch")
    return `${c(YELLOW, "WebSearch")}  ${c(DIM, trunc(inp.query ?? "?", 90))}`;
  if (["TaskCreate", "TaskUpdate", "TaskGet", "TaskList"].includes(name)) {
    const bits = ["title", "description", "status", "task_id"]
      .filter(k => k in inp)
      .map(k => `${k}=${trunc(inp[k], 40)}`);
    return `${c(YELLOW, name)}  ${c(DIM, bits.join("  "))}`;
  }
  const keys  = Object.keys(inp).slice(0, 3);
  const brief = keys.map(k => `${k}=${trunc(inp[k], 30)}`).join("  ");
  return `${c(YELLOW, name)}  ${c(DIM, brief)}`;
}

function toolResultText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content))
    return content
      .filter(item => item?.type === "text")
      .map(item => item.text ?? "")
      .join("\n");
  return String(content ?? "");
}

// ── Renderers ─────────────────────────────────────────────────────────────────
function render(obj) {
  const t  = obj.type;
  const st = obj.subtype;

  // ── session init ────────────────────────────────────────────────────────────
  if (t === "system" && st === "init") {
    const sid = (obj.session_id ?? "?").slice(0, 8);
    console.log(`\n${c(BOLD + CYAN, "══ SESSION START")}  ${obj.model ?? "?"}  ${c(DIM, `id=${sid}  mode=${obj.permissionMode ?? ""}  v${obj.claude_code_version ?? ""}`)}`);
    console.log(`   ${c(DIM, obj.cwd ?? "")}\n`);
    return;
  }

  // ── task lifecycle ──────────────────────────────────────────────────────────
  if (t === "system" && st === "task_started") {
    console.log(`${c(MAGENTA, "▶ TASK")}  ${c(BOLD, trunc(obj.description ?? "", 80))}  ${c(DIM, obj.task_type ?? "")}`);
    return;
  }

  if (t === "system" && st === "task_progress") {
    const { total_tokens: toks = 0, tool_uses: uses = 0, duration_ms: ms = 0 } = obj.usage ?? {};
    console.log(`  ${c(DIM, "~")} ${c(DIM, trunc(obj.description ?? "", 50))}  ${c(DIM, `tool=${obj.last_tool_name ?? ""}  tok=${toks.toLocaleString()}  uses=${uses}  ${(ms / 1000).toFixed(1)}s`)}`);
    return;
  }

  if (t === "system" && st === "task_notification") {
    const status = obj.status ?? "?";
    const { total_tokens: toks = 0, tool_uses: uses = 0, duration_ms: ms = 0 } = obj.usage ?? {};
    console.log(`${c(status === "completed" ? GREEN : RED, "✓ TASK")}  status=${status}  ${c(DIM, `tok=${toks.toLocaleString()}  uses=${uses}  ${(ms / 1000).toFixed(1)}s`)}`);
    if (obj.summary) console.log(`  ${c(DIM, trunc(obj.summary, 120))}`);
    return;
  }

  // ── assistant messages ──────────────────────────────────────────────────────
  if (t === "assistant") {
    const content = obj.message?.content;
    if (!Array.isArray(content)) return;
    for (const block of content) {
      if (block.type === "text") {
        const text = (block.text ?? "").trim();
        if (text) console.log(`${c(CYAN, "[AI]")} ${trunc(text, 200)}`);
      } else if (block.type === "tool_use") {
        console.log(`  ${c(YELLOW, "→")} ${toolSummary(block.name ?? "?", block.input ?? {})}`);
      }
    }
    return;
  }

  // ── user (tool results) ─────────────────────────────────────────────────────
  if (t === "user") {
    const content = obj.message?.content;
    if (!Array.isArray(content)) return;
    for (const block of content) {
      if (block.type !== "tool_result") continue;
      const text = toolResultText(block.content ?? "").trim();
      if (!text) continue;
      const label = block.is_error ? c(RED, "  ✗") : c(DIM, "  ←");
      console.log(`${label} ${c(DIM, trunc(text, 120))}`);
    }
    return;
  }

  // ── rate limit ──────────────────────────────────────────────────────────────
  if (t === "rate_limit_event") {
    console.log(`${c(YELLOW, "[RATE LIMIT]")}  ${c(DIM, JSON.stringify(obj.rate_limit_info ?? {}).slice(0, 80))}`);
    return;
  }

  // ── final result ────────────────────────────────────────────────────────────
  if (t === "result") {
    const is_err  = obj.is_error ?? false;
    const cost    = obj.total_cost_usd ?? 0;
    const result  = obj.result ?? "";
    const ms      = obj.duration_ms ?? 0;
    const { input_tokens: in_tok = 0, output_tokens: out_tok = 0,
            cache_read_input_tokens: cache_r = 0, cache_creation_input_tokens: cache_w = 0 } = obj.usage ?? {};
    const color   = (is_err || st !== "success") ? RED : GREEN;
    const icon    = is_err ? "✗ ERROR" : (st === "success" ? "✓ DONE" : "? RESULT");
    console.log(`\n${c(color, BOLD + icon)}  turns=${obj.num_turns ?? "?"}  cost=$${cost.toFixed(4)}  ${c(DIM, `${(ms / 1000).toFixed(1)}s  in=${in_tok.toLocaleString()}  out=${out_tok.toLocaleString()}  cache_r=${cache_r.toLocaleString()}  cache_w=${cache_w.toLocaleString()}`)}`);
    if (obj.terminal_reason) console.log(`  reason: ${c(DIM, obj.terminal_reason)}`);
    if (result) {
      const lines = result.trim().split("\n");
      for (const line of lines.slice(0, 12)) console.log(`  ${line}`);
      if (lines.length > 12) console.log(`  ${c(DIM, `… (${lines.length - 12} more lines)`)}`);
    }
    console.log();
    return;
  }
}

// ── File selection ────────────────────────────────────────────────────────────
function findLog() {
  const logDir  = ".yoke/logs";
  const phase   = process.env.PHASE ?? "";
  const feature = process.env.FEATURE ?? "";

  let files;
  try {
    files = readdirSync(logDir).filter(f => f.endsWith(".jsonl"));
  } catch {
    process.stderr.write(`No matching logs in ${logDir}\n`);
    process.exit(1);
  }

  if (phase || feature) {
    files = files.filter(f => (!phase || f.includes(phase)) && (!feature || f.includes(feature)));
  }

  if (!files.length) {
    process.stderr.write(`No matching logs in ${logDir}\n`);
    process.exit(1);
  }

  files.sort((a, b) => statSync(join(logDir, b)).mtimeMs - statSync(join(logDir, a)).mtimeMs);
  return join(logDir, files[0]);
}

// ── Main ──────────────────────────────────────────────────────────────────────
const logPath = process.argv[2] ?? findLog();
console.log(c(DIM, `Tailing: ${logPath}`));

const fd       = openSync(logPath, "r");
const CHUNK    = 65536;
const buf      = Buffer.alloc(CHUNK);
let   pos      = 0;
let   leftover = "";

function readAndRender() {
  let chunk = "";
  let nread;
  while ((nread = readSync(fd, buf, 0, CHUNK, pos)) > 0) {
    pos   += nread;
    chunk += buf.subarray(0, nread).toString("utf8");
  }
  if (!chunk) return;

  const lines = (leftover + chunk).split("\n");
  leftover    = lines.pop(); // last element may be an incomplete line

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try { render(JSON.parse(trimmed)); } catch { /* ignore malformed lines */ }
  }
}

readAndRender(); // drain existing content

const interval = setInterval(readAndRender, 150);

process.on("SIGINT", () => {
  clearInterval(interval);
  console.log(`\n${c(DIM, "(stopped)")}`);
  process.exit(0);
});
