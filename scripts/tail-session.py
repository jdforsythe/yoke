#!/usr/bin/env python3
"""
tail-session.py — human-readable tail of a Yoke session .jsonl log.

Usage:
    python3 scripts/tail-session.py <path/to/session.jsonl>
    python3 scripts/tail-session.py            # picks newest log in .yoke/logs/

Env vars (mirror make targets):
    PHASE=implement|review
    FEATURE=feat-something
"""

import json
import os
import sys
import time
import textwrap
from pathlib import Path

# ── ANSI colours ────────────────────────────────────────────────────────────
RESET  = "\033[0m"
BOLD   = "\033[1m"
DIM    = "\033[2m"
CYAN   = "\033[36m"
YELLOW = "\033[33m"
GREEN  = "\033[32m"
RED    = "\033[31m"
MAGENTA= "\033[35m"
BLUE   = "\033[34m"
WHITE  = "\033[37m"

def c(color, text):
    return f"{color}{text}{RESET}"

def wrap(text, indent=4, width=100):
    return textwrap.fill(text, width=width, subsequent_indent=" " * indent)

# ── Helpers ──────────────────────────────────────────────────────────────────
def trunc(s, n=120):
    s = str(s).strip().replace("\n", " ↵ ")
    return s[:n] + "…" if len(s) > n else s

def tool_summary(name, inp):
    """One-line description of a tool call."""
    if name == "Bash":
        cmd = inp.get("command", "")
        return f"{c(YELLOW, 'Bash')}  {c(DIM, trunc(cmd, 90))}"
    if name in ("Read", "Write", "Edit"):
        return f"{c(YELLOW, name)}  {c(DIM, inp.get('file_path', '?'))}"
    if name == "Glob":
        path = inp.get("path", "")
        return f"{c(YELLOW, 'Glob')}  {inp.get('pattern', '?')}" + (f"  in {c(DIM, path)}" if path else "")
    if name == "Grep":
        pat = inp.get("pattern", "?")
        path = inp.get("path", "")
        return f"{c(YELLOW, 'Grep')}  /{pat}/" + (f"  in {c(DIM, path)}" if path else "")
    if name == "Agent":
        sub = inp.get("subagent_type", "")
        desc = inp.get("description", "?")
        label = f"Agent({sub})" if sub else "Agent"
        return f"{c(MAGENTA, label)}  {c(DIM, trunc(desc, 80))}"
    if name == "WebFetch":
        return f"{c(YELLOW, 'WebFetch')}  {c(DIM, trunc(inp.get('url','?'), 90))}"
    if name == "WebSearch":
        return f"{c(YELLOW, 'WebSearch')}  {c(DIM, trunc(inp.get('query','?'), 90))}"
    if name in ("TaskCreate", "TaskUpdate", "TaskGet", "TaskList"):
        bits = []
        for k in ("title", "description", "status", "task_id"):
            if k in inp:
                bits.append(f"{k}={trunc(inp[k], 40)}")
        return f"{c(YELLOW, name)}  {c(DIM, '  '.join(bits))}"
    # fallback
    keys = list(inp.keys())[:3]
    brief = "  ".join(f"{k}={trunc(inp[k], 30)}" for k in keys)
    return f"{c(YELLOW, name)}  {c(DIM, brief)}"

def tool_result_text(content):
    """Extract text from a tool_result content field."""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for item in content:
            if isinstance(item, dict) and item.get("type") == "text":
                parts.append(item.get("text", ""))
        return "\n".join(parts)
    return str(content)

# ── Renderers ────────────────────────────────────────────────────────────────
def render(obj):
    t  = obj.get("type")
    st = obj.get("subtype")

    # ── session init ──────────────────────────────────────────────────────
    if t == "system" and st == "init":
        model  = obj.get("model", "?")
        sid    = obj.get("session_id", "?")[:8]
        mode   = obj.get("permissionMode", "")
        cwd    = obj.get("cwd", "")
        ver    = obj.get("claude_code_version", "")
        print(f"\n{c(BOLD+CYAN, '══ SESSION START')}  {model}  {c(DIM, f'id={sid}  mode={mode}  v{ver}')}")
        print(f"   {c(DIM, cwd)}\n")
        return

    # ── task lifecycle ────────────────────────────────────────────────────
    if t == "system" and st == "task_started":
        desc = obj.get("description", "")
        ttype = obj.get("task_type", "")
        print(f"{c(MAGENTA, '▶ TASK')}  {c(BOLD, trunc(desc, 80))}  {c(DIM, ttype)}")
        return

    if t == "system" and st == "task_progress":
        desc  = obj.get("description", "")
        tool  = obj.get("last_tool_name", "")
        usage = obj.get("usage", {})
        toks  = usage.get("total_tokens", 0)
        uses  = usage.get("tool_uses", 0)
        ms    = usage.get("duration_ms", 0)
        print(f"  {c(DIM, '~')} {c(DIM, trunc(desc, 50))}  "
              f"{c(DIM, f'tool={tool}  tok={toks:,}  uses={uses}  {ms/1000:.1f}s')}")
        return

    if t == "system" and st == "task_notification":
        status  = obj.get("status", "?")
        summary = obj.get("summary", "")
        usage   = obj.get("usage", {})
        toks    = usage.get("total_tokens", 0)
        uses    = usage.get("tool_uses", 0)
        ms      = usage.get("duration_ms", 0)
        color   = GREEN if status == "completed" else RED
        print(f"{c(color, '✓ TASK')}  status={status}  "
              f"{c(DIM, f'tok={toks:,}  uses={uses}  {ms/1000:.1f}s')}")
        if summary:
            print(f"  {c(DIM, trunc(summary, 120))}")
        return

    # ── assistant messages ────────────────────────────────────────────────
    if t == "assistant":
        msg     = obj.get("message", {})
        content = msg.get("content", [])
        if not isinstance(content, list):
            return
        for block in content:
            btype = block.get("type")
            if btype == "text":
                text = block.get("text", "").strip()
                if text:
                    # Print first ~200 chars; wrap if multi-line
                    short = trunc(text, 200)
                    print(f"{c(CYAN, '[AI]')} {short}")
            elif btype == "tool_use":
                name = block.get("name", "?")
                inp  = block.get("input", {})
                print(f"  {c(YELLOW, '→')} {tool_summary(name, inp)}")
        return

    # ── user (tool results) ───────────────────────────────────────────────
    if t == "user":
        msg     = obj.get("message", {})
        content = msg.get("content", [])
        if not isinstance(content, list):
            return
        for block in content:
            if block.get("type") == "tool_result":
                raw   = block.get("content", "")
                is_err = block.get("is_error", False)
                text  = tool_result_text(raw).strip()
                if text:
                    label = c(RED, "  ✗") if is_err else c(DIM, "  ←")
                    print(f"{label} {c(DIM, trunc(text, 120))}")
        return

    # ── rate limit ────────────────────────────────────────────────────────
    if t == "rate_limit_event":
        info = obj.get("rate_limit_info", {})
        print(f"{c(YELLOW, '[RATE LIMIT]')}  {c(DIM, json.dumps(info)[:80])}")
        return

    # ── final result ──────────────────────────────────────────────────────
    if t == "result":
        is_err   = obj.get("is_error", False)
        turns    = obj.get("num_turns", "?")
        cost     = obj.get("total_cost_usd", 0) or 0
        reason   = obj.get("terminal_reason", "")
        result   = obj.get("result", "")
        usage    = obj.get("usage", {})
        in_tok   = usage.get("input_tokens", 0)
        out_tok  = usage.get("output_tokens", 0)
        cache_r  = usage.get("cache_read_input_tokens", 0)
        cache_w  = usage.get("cache_creation_input_tokens", 0)
        color    = RED if (is_err or st != "success") else GREEN
        icon     = "✗ ERROR" if is_err else ("✓ DONE" if st == "success" else "? RESULT")
        ms       = obj.get("duration_ms", 0) or 0
        print(f"\n{c(color, BOLD + icon)}  turns={turns}  cost=${cost:.4f}  "
              f"{c(DIM, f'{ms/1000:.1f}s  in={in_tok:,}  out={out_tok:,}  cache_r={cache_r:,}  cache_w={cache_w:,}')}")
        if reason:
            print(f"  reason: {c(DIM, reason)}")
        if result:
            # Print up to first 400 chars of the result
            lines = result.strip().splitlines()
            for line in lines[:12]:
                print(f"  {line}")
            if len(lines) > 12:
                print(f"  {c(DIM, f'… ({len(lines)-12} more lines)')}")
        print()
        return

# ── File selection ────────────────────────────────────────────────────────────
def find_log():
    log_dir = Path(".yoke/logs")
    phase   = os.environ.get("PHASE", "")
    feature = os.environ.get("FEATURE", "")
    pattern = f"*{phase}*{feature}*.jsonl" if (phase or feature) else "*.jsonl"
    logs    = sorted(log_dir.glob(pattern), key=lambda p: p.stat().st_mtime, reverse=True)
    if not logs:
        print(f"No matching logs in {log_dir}", file=sys.stderr)
        sys.exit(1)
    return logs[0]

# ── Main ──────────────────────────────────────────────────────────────────────
def main():
    if len(sys.argv) > 1:
        path = Path(sys.argv[1])
    else:
        path = find_log()

    print(f"{c(DIM, f'Tailing: {path}')}")

    with open(path, "r", errors="replace") as f:
        # drain existing content first
        while True:
            line = f.readline()
            if not line:
                break
            line = line.strip()
            if not line:
                continue
            try:
                render(json.loads(line))
            except Exception:
                pass

        # follow for new lines
        try:
            while True:
                line = f.readline()
                if not line:
                    time.sleep(0.15)
                    continue
                line = line.strip()
                if not line:
                    continue
                try:
                    render(json.loads(line))
                except Exception:
                    pass
        except KeyboardInterrupt:
            print(f"\n{c(DIM, '(stopped)')}")

if __name__ == "__main__":
    main()
