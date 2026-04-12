#!/usr/bin/env python3
"""yoke-v0-helper — prompt assembly and session bookkeeping for yoke-v0.

Subcommands:
  assemble <phase> <feat-id> <config> <prompt-out>   render template, print cfg JSON
  record   <sessions> <phase> <feat> <log> <ec>      index session, print session_id
  find-log <sessions> <sid-prefix>                   print log path for session
"""
import sys, json, os, re, subprocess
from datetime import datetime, timezone
from pathlib import Path


def die(msg):
    print(f"yoke-v0-helper: {msg}", file=sys.stderr); sys.exit(1)

def read_or_empty(path):
    try: return Path(path).read_text(encoding="utf-8")
    except FileNotFoundError: return ""

def load_config(path):
    cfg = {"command": "claude",
           "args": ["--print", "--verbose", "--output-format", "stream-json"],
           "features_file": "docs/idea/yoke-features.json",
           "pre": [], "post": []}
    try: cfg.update(json.loads(Path(path).read_text()))
    except FileNotFoundError: pass
    except json.JSONDecodeError as e: die(f"config error: {e}")
    return cfg

def load_feature(features_file, feature_id):
    try: data = json.loads(Path(features_file).read_text())
    except FileNotFoundError: die(f"features file not found: {features_file}")
    except json.JSONDecodeError as e: die(f"features JSON error: {e}")
    for f in data.get("features", []):
        if f.get("id") == feature_id:
            return data.get("project", "yoke"), f
    die(f"feature '{feature_id}' not found in {features_file}")

def load_handoff(feature_id):
    raw = read_or_empty("handoff.json").strip()
    if not raw: return "[]"
    try:
        entries = json.loads(raw)
        if isinstance(entries, list):
            return json.dumps([e for e in entries if e.get("feature_id") == feature_id], indent=2)
    except json.JSONDecodeError: pass
    return "[]"

def git_run(*cmd, max_bytes=20_000):
    try:
        r = subprocess.run(list(cmd), capture_output=True, text=True, timeout=15)
        out = r.stdout.strip()
        return (out[:max_bytes] + "\n...(truncated)" if len(out) > max_bytes else out) or "(empty)"
    except Exception as e: return f"(unavailable: {e})"

def resolve(name, ctx):
    val = ctx
    for part in name.split("."):
        if isinstance(val, dict) and part in val: val = val[part]
        else: return "", False
    return (json.dumps(val, indent=2) if isinstance(val, (dict, list)) else ("" if val is None else str(val))), True

def render(template, ctx, path=""):
    def sub(m):
        name = m.group(1); val, found = resolve(name, ctx)
        if not found:
            raise ValueError(f'PromptTemplateError: unknown variable "{name}"\n'
                             f"  template: {path}\n  known: {', '.join(ctx.keys())}")
        return val
    return re.sub(r'\{\{([A-Za-z_][A-Za-z0-9_.]*)\}\}', sub, template)

def cmd_assemble(args):
    if len(args) != 4: die("assemble: <phase> <feat-id> <config> <prompt-out>")
    phase, feature_id, config_path, prompt_output = args
    cfg = load_config(config_path)
    workflow_name, feature = load_feature(cfg["features_file"], feature_id)
    tpl_path = f"prompts/{phase}.md"
    template = read_or_empty(tpl_path)
    if not template: die(f"template not found: {tpl_path}")
    ctx = {
        "workflow_name": workflow_name, "stage_id": phase,
        "item_id": feature_id, "item": feature,
        "item_state": {"status": "in_progress", "current_phase": phase,
                       "retry_count": 0, "blocked_reason": None},
        "architecture_md": read_or_empty("docs/design/architecture.md"),
        "progress_md":     read_or_empty("progress.md"),
        "handoff_entries": load_handoff(feature_id),
        "git_log_recent":  git_run("git", "log", "-20", "--oneline"),
        "recent_diff":     git_run("git", "diff", "HEAD~5..HEAD"),
        "user_injected_context": os.environ.get("YOKE_CONTEXT", ""),
    }
    try: prompt = render(template, ctx, tpl_path)
    except ValueError as e: die(str(e))
    Path(prompt_output).write_text(prompt, encoding="utf-8")
    print(json.dumps({"command": cfg["command"], "args": cfg["args"],
                      "pre": cfg.get("pre", []), "post": cfg.get("post", [])}))

def cmd_record(args):
    if len(args) != 5: die("record: <sessions> <phase> <feat> <log> <ec>")
    sessions_file, phase, feat, log_path, ec = args
    ec = int(ec); sid = "unknown"
    try:
        with open(log_path) as f:
            for line in f:
                ev = json.loads(line)
                if ev.get("type") == "system" and ev.get("subtype") == "init":
                    sid = ev.get("session_id", "unknown"); break
    except Exception: pass
    entry = {"ts": datetime.now(timezone.utc).isoformat(), "phase": phase,
             "feature_id": feat, "log_path": log_path, "exit_code": ec, "session_id": sid}
    with open(sessions_file, "a") as f: f.write(json.dumps(entry) + "\n")
    print(sid)

def cmd_find_log(args):
    if len(args) != 2: die("find-log: <sessions> <sid-prefix>")
    sessions_file, prefix = args; last = None
    try:
        with open(sessions_file) as f:
            for line in f:
                e = json.loads(line)
                if e.get("session_id", "").startswith(prefix): last = e["log_path"]
    except Exception: pass
    if last: print(last)
    else: sys.exit(1)

CMDS = {"assemble": cmd_assemble, "record": cmd_record, "find-log": cmd_find_log}

if __name__ == "__main__":
    if len(sys.argv) < 2 or sys.argv[1] not in CMDS:
        print(f"Usage: yoke-v0-helper.py <{' | '.join(CMDS)}> [args]", file=sys.stderr); sys.exit(1)
    CMDS[sys.argv[1]](sys.argv[2:])
