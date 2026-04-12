# Claude Code Hook Semantics — Empirical Research

Phase γ research. Empirically verified on Claude Code v2.1.104
(2026-04-12) using throwaway project at `/tmp/yoke-hook-research/`.

**Why this matters to Yoke.** Yoke does not own or install hooks
(D55). But the hook-contract doc (`docs/design/hook-contract.md` §3)
has nine TBD items that Yoke needs answered to correctly specify the
quality-gate contract and to write accurate example templates in
quick-start docs.

---

## 1. Hook configuration file paths

Hooks live inside the `"hooks"` key of **settings JSON files**. There
is **no separate `hooks.json`**. Scoping levels, in order of
precedence:

| File | Scope | Committed? |
|---|---|---|
| `~/.claude/settings.json` | User-wide (all projects) | No |
| `.claude/settings.json` | Project-wide | Yes |
| `.claude/settings.local.json` | Project-local | No (gitignored) |
| Managed policy settings | Organization-wide (admin) | N/A |

All tests in this document used `.claude/settings.json` at the project
root. Verified: Claude Code reads hooks from this file on every
session start (no restart required; changes take effect on next
`claude -p` invocation).

### Minimal configuration example

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "/path/to/script.sh",
            "timeout": 30
          }
        ]
      }
    ]
  }
}
```

The three-level nesting is: `hooks` → `EventName` → array of
**hook groups** (each with optional `matcher`) → each group has
`hooks` array of **hook entries** (each with `type`, `command`,
optional `timeout`).

---

## 2. Exit code matrix — Stop hook

Tested empirically. Each row below was verified with a dedicated
script and captured stream-json output.

| Exit code | Claude behavior | Session outcome | Feedback format |
|---|---|---|---|
| **0** (no stdout JSON) | Success. Session ends normally. | `result.subtype: "success"`, `terminal_reason: "completed"` | None |
| **0** + JSON `{"decision":"block","reason":"..."}` | Blocked. `reason` is injected as a user message. Claude gets another turn. | Continues until `stop_hook_active` guard fires or max-turns | `"Stop hook feedback:\n<reason>"` |
| **2** | Blocking error. stderr is injected as a user message. Claude gets another turn. | Continues (same as decision:block) | `"Stop hook feedback:\n[<script_path>]: <stderr>"` |
| **1** | Non-blocking error. Hook failure is logged but session ends normally. | `result.subtype: "success"` | None visible to model |
| **127** | Non-blocking error (same as exit 1). | `result.subtype: "success"` | None visible to model |
| **ENOENT** (missing script) | Non-blocking error. | `result.subtype: "success"` | None visible to model |
| **timeout** (hook killed) | Non-blocking error. Hook process is killed at the timeout boundary. | `result.subtype: "success"` | None visible to model |

### Key observations

1. **Only exit 2 is blocking.** Every other non-zero exit code
   (1, 127, signal, timeout) is treated as a non-blocking error —
   the action proceeds and the error is logged to debug output.

2. **Exit 0 + JSON can also block.** Writing
   `{"decision":"block","reason":"..."}` to stdout with exit 0 has
   the same behavioral effect as exit 2 + stderr — Claude gets the
   feedback and continues.

3. **The `stop_hook_active` guard is critical.** When a Stop hook
   blocks, Claude gets another turn. When Claude stops again, the
   Stop hook fires a second time with `stop_hook_active: true` in
   stdin. The hook script must check this field and exit 0 to break
   the cycle. Without this guard, the session loops until max-turns.

4. **Feedback format differs.** Exit 2 includes the script path in
   the feedback: `[/path/to/script.sh]: <stderr>`. JSON
   decision:block delivers the reason string verbatim.

### Test evidence: exit 2 → Claude retries

Stream-json excerpt (test2):
```
[assistant text]: HELLO_EXIT2_TEST
[user message]:   "Stop hook feedback:\n[/tmp/.../stop-exit2.sh]: STOP BLOCKED: tests are failing, please fix them before stopping"
[assistant text]: "Tests are failing and the stop hook is blocking. Let me investigate..."
[result]:         subtype: "error_max_turns" (hit --max-turns 3 cap)
```

### Test evidence: exit 0 + decision:block → Claude retries then stops

Stream-json excerpt (test7):
```
[assistant]:     HELLO_JSON_BLOCK
[user feedback]: "Stop hook feedback:\nPlease run: echo HOOK_VERIFICATION_COMPLETE"
[tool_use]:      Bash → echo HOOK_VERIFICATION_COMPLETE
[assistant]:     HOOK_VERIFICATION_COMPLETE
[result]:        subtype: "success", num_turns: 3
```

Hook log shows two firings: first with `stop_hook_active=false`
(blocked), second with `stop_hook_active=true` (allowed through).

---

## 3. Exit code matrix — PreToolUse hook

Tested with `matcher: "Bash"` to target Bash tool calls only.

| Exit code | Claude behavior | Tool outcome | Feedback format |
|---|---|---|---|
| **0** (no stdout JSON) | Success. Tool call proceeds normally. | Executes | None |
| **0** + JSON deny | Tool blocked. `permissionDecisionReason` returned as tool_result. | Blocked | Reason string as tool_result text |
| **2** | Blocking error. stderr returned as tool_result error. | Blocked | `"PreToolUse:Bash hook error: [<path>]: <stderr>"` |
| **1** | Non-blocking error. Tool call proceeds normally. | Executes | None visible to model |

### Behavioral differences from Stop hook

| Aspect | Stop hook | PreToolUse hook |
|---|---|---|
| Exit 2 feedback injection | User message (`"Stop hook feedback: ..."`) | Tool result error (`"PreToolUse:<Tool> hook error: ..."`) |
| Effect of blocking | Session continues (Claude gets new turn) | Tool call is skipped; Claude sees error in tool_result |
| Infinite-loop guard | `stop_hook_active` field in stdin | Not needed (tool is simply blocked; Claude adapts) |
| Matcher semantics | No matcher (fires on every stop) | Matches tool name (`"Bash"`, `"Edit\|Write"`, `"mcp__.*"`) |

### Test evidence: JSON deny

PreToolUse hook stdout:
```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "deny",
    "permissionDecisionReason": "Safety policy: this tool call is blocked by the quality gate"
  }
}
```

Stream-json result:
```
[tool_use]:    Bash → echo PTU_JSON_DENY_TEST
[tool_result]: "Safety policy: this tool call is blocked by the quality gate"
[assistant]:   "The command was blocked by a pre-tool-use hook..."
```

The `permissionDecisionReason` string becomes the verbatim tool_result
text. Claude sees it as a tool error and reports accordingly.

---

## 4. Hook stdin JSON schema

### Common fields (all events)

```json
{
  "session_id":      "uuid-v4",
  "transcript_path": "/Users/<user>/.claude/projects/<project-hash>/<session-id>.jsonl",
  "cwd":             "/absolute/path/to/project",
  "permission_mode": "default",
  "hook_event_name": "Stop"
}
```

### Stop-specific fields

```json
{
  "stop_hook_active":     false,
  "last_assistant_message": "text of Claude's last response"
}
```

- `stop_hook_active` (boolean): `true` if the Stop hook already
  fired once this turn and triggered a continuation. Use this to
  guard against infinite loops.
- `last_assistant_message` (string): the full text of Claude's
  last response before the stop event.

**Empirically captured (test1):**
```json
{
    "session_id": "84726893-981c-4075-9236-370ed91b51c2",
    "transcript_path": "/Users/jforsythe/.claude/projects/-private-tmp-yoke-hook-research/84726893-981c-4075-9236-370ed91b51c2.jsonl",
    "cwd": "/private/tmp/yoke-hook-research",
    "permission_mode": "default",
    "hook_event_name": "Stop",
    "stop_hook_active": false,
    "last_assistant_message": "HELLO_HOOK_TEST"
}
```

### PreToolUse-specific fields

```json
{
  "tool_name":   "Bash",
  "tool_input":  { "command": "echo test", "description": "..." },
  "tool_use_id": "toolu_01KhfS1djjKFYhb5VUCFp6eb"
}
```

- `tool_name` (string): the tool being invoked (e.g., `"Bash"`,
  `"Edit"`, `"Write"`, `"Read"`, `"Glob"`, `"Grep"`,
  `"mcp__server__tool"`).
- `tool_input` (object): the full input parameters for the tool call.
  Shape depends on the tool.
- `tool_use_id` (string): Anthropic tool-use ID for this specific
  invocation.

**Empirically captured (test8):**
```json
{
    "session_id": "b599b454-7d3f-4b56-8527-c5a640f68e00",
    "transcript_path": "/Users/jforsythe/.claude/projects/-private-tmp-yoke-hook-research/b599b454-7d3f-4b56-8527-c5a640f68e00.jsonl",
    "cwd": "/private/tmp/yoke-hook-research",
    "permission_mode": "default",
    "hook_event_name": "PreToolUse",
    "tool_name": "Bash",
    "tool_input": {
        "command": "echo PTU_TEST_MARKER",
        "description": "Print test marker string"
    },
    "tool_use_id": "toolu_01KhfS1djjKFYhb5VUCFp6eb"
}
```

### Notable: transcript_path

The `transcript_path` points to a `.jsonl` file containing the full
session transcript. A Stop hook can read this file to inspect what
Claude did during the session. This is how a quality-gate hook could
check whether Claude used certain tools, made specific changes, etc.

---

## 5. Hook stdout JSON contract

### Stop hook

**Allow stop (default — no output needed):**
Exit 0, write nothing to stdout (or any non-JSON text).

**Block stop and give feedback:**
```json
{"decision": "block", "reason": "Human-readable feedback for Claude"}
```

Exit 0 required. The `reason` string is injected as a user message
prefixed with `"Stop hook feedback:\n"`.

### PreToolUse hook

**Allow tool call (default — no output needed):**
Exit 0, write nothing to stdout.

**Deny tool call:**
```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "deny",
    "permissionDecisionReason": "Why this call is blocked"
  }
}
```

Exit 0 required. The `permissionDecisionReason` string becomes the
tool_result text that Claude sees.

**Other documented decisions (not empirically tested):**
```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "allow",
    "updatedInput": { "command": "safer-version" },
    "additionalContext": "Extra context for Claude"
  }
}
```

- `"allow"` — skip permission prompt (tool executes).
- `"ask"` — show permission prompt (normal interactive behavior).
- `"defer"` — pause in non-interactive mode (`-p`) for external
  processing.
- `"updatedInput"` — rewrite the tool input before execution.

---

## 6. Default timeout behavior

| Hook type | Default timeout |
|---|---|
| `command` | **600 seconds** (10 minutes) |
| `prompt` | 30 seconds |
| `agent` | 60 seconds |

Override per hook with `"timeout": <seconds>` in the hook entry.

**Empirically verified:** configured `"timeout": 10` on a script
that sleeps 60 seconds. The session completed in 18 seconds (10s
timeout + Claude processing). The hook process was killed. The
timeout is treated as a **non-blocking error** — the session ends
normally.

**Implication for quality-gate hooks:** a Stop hook that runs
`pnpm typecheck && pnpm test` could take several minutes. The 600s
default is generous, but the hook should be configured with an
explicit timeout matching the expected CI duration to avoid
unexplained hangs.

---

## 7. Matcher semantics

Matchers are set per hook-group (not per hook entry) and filter when
the hooks in that group fire.

**PreToolUse matchers** match against `tool_name`:
- Exact: `"Bash"`, `"Edit"`, `"Write"`
- Multi-match (pipe): `"Edit|Write"`
- Regex: `"mcp__.*"`, `"^Notebook"`

**Stop matchers** — not applicable (Stop fires once per turn end).

**`if` field** (per hook entry, PreToolUse only) — filters by tool
name AND arguments:
```json
{
  "matcher": "Bash",
  "hooks": [{
    "type": "command",
    "if": "Bash(git *)",
    "command": "/path/to/git-guard.sh"
  }]
}
```

This fires only when Claude runs a `git` command via Bash, not other
Bash commands.

---

## 8. Can a Stop hook read the session transcript?

**Yes.** The `transcript_path` field in stdin points to the session's
`.jsonl` transcript file. The hook can read this file to inspect the
full conversation, tool calls, and outputs.

Path format: `~/.claude/projects/<project-hash>/<session-id>.jsonl`

This enables a quality-gate hook to verify that Claude actually ran
tests, check what files were modified, etc. — not just check exit
codes.

---

## 9. Invocation granularity

- **Stop**: fires once per turn end (when Claude finishes responding).
  If blocked via exit 2 or decision:block, Claude gets another turn,
  and the hook fires again when Claude next stops.
- **PreToolUse**: fires once per tool call, before execution. The
  matcher filters which tool calls trigger the hook.

---

## 10. Recommendations for Yoke example templates

### Quality-gate Stop hook (`require-passing-checks.sh`)

```bash
#!/bin/bash
# Example quality-gate Stop hook for Yoke-managed sessions.
# Runs type-check and test suite; blocks session termination if failing.
# Writes .yoke/last-check.json manifest for dashboard visibility.
#
# Install: add to .claude/settings.json → hooks.Stop
# Guard:   checks stop_hook_active to prevent infinite retry loops

set -euo pipefail

INPUT=$(cat)
STOP_HOOK_ACTIVE=$(echo "$INPUT" | jq -r '.stop_hook_active // false')

# Guard: if we already fired once this turn, let Claude stop
if [ "$STOP_HOOK_ACTIVE" = "true" ]; then
  exit 0
fi

MANIFEST=".yoke/last-check.json"
mkdir -p .yoke

GATES='[]'
ALL_OK=true
RAN_AT=$(date -u +%FT%TZ)

run_gate() {
  local name="$1"; shift
  local start_ms=$(($(date +%s) * 1000))
  if "$@" > /dev/null 2>&1; then
    local ok=true
  else
    local ok=false
    ALL_OK=false
  fi
  local end_ms=$(($(date +%s) * 1000))
  local dur=$((end_ms - start_ms))
  GATES=$(echo "$GATES" | jq --arg n "$name" --argjson ok "$ok" --argjson d "$dur" \
    '. + [{"name": $n, "ok": $ok, "duration_ms": $d}]')
}

run_gate "typecheck" pnpm typecheck
run_gate "lint"      pnpm lint
run_gate "test"      pnpm test

# Write manifest (dashboard reads this; not required for phase acceptance)
jq -n --arg v "1" --arg t "$RAN_AT" --argjson g "$GATES" \
  '{"hook_version": $v, "ran_at": $t, "gates": $g}' > "$MANIFEST"

if [ "$ALL_OK" = "false" ]; then
  FAILING=$(echo "$GATES" | jq -r '.[] | select(.ok == false) | .name' | tr '\n' ', ')
  echo "Quality gate failed: ${FAILING%, }. Fix and try again." >&2
  exit 2
fi

exit 0
```

**Why exit 2 over JSON decision:block:** simpler to implement in
shell; the behavioral effect is identical (stderr fed to Claude,
session continues). JSON stdout is better when structured data needs
to be communicated to Claude (e.g., which specific test failed).

**Why the `stop_hook_active` guard:** without it, if the checks
continue to fail after Claude's fix attempt, the session enters an
infinite retry loop bounded only by max-turns. The guard ensures
Claude gets exactly one retry opportunity before being allowed to
stop.

### Safety PreToolUse hook

```bash
#!/bin/bash
# Example safety hook: block destructive git commands.
# Install: add to .claude/settings.json → hooks.PreToolUse
#          with matcher: "Bash" and if: "Bash(git *)"

INPUT=$(cat)
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // ""')

# Block force-push, reset --hard, branch -D
if echo "$COMMAND" | grep -qE 'git\s+(push\s+.*--force|reset\s+--hard|branch\s+-D)'; then
  cat <<'EOF'
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"Safety policy: destructive git operations (force-push, reset --hard, branch -D) are blocked. Use non-destructive alternatives."}}
EOF
  exit 0
fi

exit 0
```

**Why JSON deny over exit 2:** for PreToolUse, JSON
`permissionDecision:deny` gives Claude a cleaner error message
(just the reason string as tool_result, without the script path
prefix). Exit 2 works too, but the error format includes
`"PreToolUse:Bash hook error: [/path]: ..."` which is noisier.

---

## 11. Test scripts and captured outputs

All test artifacts are in `/tmp/yoke-hook-research/`:

```
scripts/
  stop-exit0.sh              # Exit 0 (success)
  stop-exit1.sh              # Exit 1 (non-blocking)
  stop-exit2.sh              # Exit 2 (blocking + stderr)
  stop-exit127.sh            # Exit 127 (simulated ENOENT)
  stop-hang.sh               # Sleep 60 (timeout test)
  stop-json-continue.sh      # Exit 0 + decision:block JSON
  stop-json-stdout.sh        # Exit 0 + JSON stdout
  stop-stdin-capture.sh      # Stdin capture for schema analysis
  pretooluse-exit0.sh        # Exit 0 (allow)
  pretooluse-exit1.sh        # Exit 1 (non-blocking)
  pretooluse-exit2.sh        # Exit 2 (block + stderr)
  pretooluse-json-deny.sh    # Exit 0 + JSON deny
  pretooluse-stdin-capture.sh # Stdin capture

captures/
  stop-stdin-full.json       # Captured Stop hook stdin
  pretooluse-stdin-full.json # Captured PreToolUse hook stdin
  test1-stream.json          # Stream-json: Stop exit 0
  test2-stream.json          # Stream-json: Stop exit 2
  test3-stream.json          # Stream-json: Stop exit 1
  test5-stream.json          # Stream-json: Stop ENOENT
  test6-stream.json          # Stream-json: Stop timeout
  test7-stream.json          # Stream-json: Stop JSON block
  test8-stream.json          # Stream-json: PreToolUse exit 0
  test9-stream.json          # Stream-json: PreToolUse exit 2
  test10-stream.json         # Stream-json: PreToolUse exit 1
  test11-stream.json         # Stream-json: PreToolUse JSON deny
```

---

## 12. Answers to hook-contract.md §3 TBD items

| Question | Answer | Evidence |
|---|---|---|
| Exit 0 on Stop hook: does Claude proceed with session termination? | **Yes.** Session ends cleanly with `result.subtype: "success"`. | test1-stream.json |
| Exit 2 on Stop hook: does Claude feed stderr back and retry? | **Yes.** Stderr injected as `"Stop hook feedback:\n[path]: msg"` user message. Claude gets another turn. | test2-stream.json |
| Exit 1 (generic): how does Claude treat it? | **Non-blocking error.** Hook failure logged; action proceeds normally. Session ends cleanly. | test3-stream.json |
| Exit on signal / ENOENT: how does Claude report it? | **Non-blocking error.** Same as exit 1. Session ends cleanly. No error visible in stream-json result. | test5-stream.json |
| stdin JSON schema delivered to hooks | See §4 above. Common fields: `session_id`, `transcript_path`, `cwd`, `permission_mode`, `hook_event_name`. Stop adds: `stop_hook_active`, `last_assistant_message`. PreToolUse adds: `tool_name`, `tool_input`, `tool_use_id`. | stop-stdin-full.json, pretooluse-stdin-full.json |
| stdout JSON schema honored by Claude from hooks | See §5 above. Stop: `{"decision":"block","reason":"..."}`. PreToolUse: `{"hookSpecificOutput":{...,"permissionDecision":"deny",...}}`. | test7-stream.json, test11-stream.json |
| Hook wall-clock timeout enforced by Claude | **Yes.** Default 600s for command hooks. Configurable per hook via `"timeout"` field (seconds). Timeout treated as non-blocking error. | test6 (10s timeout on 60s sleep → session completed in 18s) |
| Can a Stop hook read the session transcript? | **Yes.** `transcript_path` in stdin points to the `.jsonl` transcript file. | stop-stdin-full.json |
| Invocation granularity | **Stop:** once per turn end. **PreToolUse:** once per tool call, filtered by matcher. | test7 log (two firings), test8 log (one firing per tool call) |
