# Continue/Resume Semantics

Phase γ research deliverable. Documents how Claude Code's `-c` and `-r`
flags work for session continuation, relevant to Yoke's multi-session
pipeline model.

Captured 2026-04-12 using Claude Code 2.1.104.

---

## 1. Session storage

Sessions are persisted to:

```
~/.claude/projects/<encoded-cwd>/<session-id>.jsonl
```

Where `<encoded-cwd>` is the working directory path with `/` replaced by
`-` (e.g., `-Users-jforsythe-dev-ai-yoke`).

**Print-mode sessions (`-p`) ARE persisted by default.** This can be
disabled with `--no-session-persistence`. Interactive sessions always
persist and additionally get a subdirectory for subagent data.

Active (running) sessions are registered in:

```
~/.claude/sessions/<pid>.json
```

Each file contains: `{ pid, sessionId, cwd, startedAt, kind, entrypoint }`.
These files are cleaned up when sessions end.

### Internal session format

The `.jsonl` file is NDJSON with these event types:

| Type | Description |
|---|---|
| `queue-operation` | `{ operation: "enqueue" \| "dequeue" }` — prompt queue management |
| `user` | User message with `{ role: "user", content: "..." }` |
| `assistant` | Assistant response with content blocks |
| `attachment` | Context attachments (e.g., CLAUDE.md files) |
| `last-prompt` | Marker for the last prompt boundary |

This is a different format from `--output-format stream-json`. The
session file is Claude Code's internal state; the stream-json output is
the external interface. Yoke should only consume the stream-json output,
not read session files directly.

---

## 2. `-c` (continue) behavior

**Syntax:** `claude -c -p "<prompt>"`

**Semantics:** Continues the most recent conversation in the current
working directory. This is determined by the session registry
(`~/.claude/sessions/`), NOT by the session files themselves.

### Critical finding: `-c` picks the wrong session

When multiple Claude Code sessions have run in the same CWD, `-c`
continues the most recent one. In testing, this picked the **outer
interactive session** (the one running this research), not the intended
`-p` session.

The capture 3b test:
- 3a: `claude -p "Remember the number 42."` → session `b9dbb534-...`
- 3b: `claude -c -p "What number did I ask you to remember?"` → session `a96bf507-...`
- **Different session IDs** — 3b did NOT continue 3a
- 3b continued the outer interactive session instead
- The model appeared to recall "42" but only because Claude Code's
  auto-memory system had saved it, not because of conversation continuity

**Verdict: `-c` is unreliable for automated use.** It picks the most
recent CWD session, which in a multi-session environment (like Yoke
running alongside an interactive Claude Code session) will often be the
wrong one.

---

## 3. `-r` (resume) behavior

**Syntax:** `claude -r <session-id> -p "<prompt>"`

**Semantics:** Resumes a specific session by UUID. The session ID must
correspond to a persisted `.jsonl` file in the project directory.

### Verified behavior

The capture 3c test:
- Resumed session `b9dbb534-...` (from capture 3a)
- Stream-json output emitted `system.init` with the **SAME session_id**
  (`b9dbb534-...`)
- Model correctly recalled "42" from actual conversation history
- Response was concise: just "42."
- The session `.jsonl` file was appended to (grew from 14 to 19 lines)

### Stream-json output on resume

A resumed session emits the same event sequence as a fresh session:
1. `system.init` (with the original session_id)
2. `assistant` events
3. `rate_limit_event`
4. `result`

There is no special "resumed" marker in the stream-json output. The
session_id being the same as the original is the only indicator.

---

## 4. `--session-id` flag

**Syntax:** `claude -p "..." --session-id <uuid>`

Not tested, but per CLI help: "Use a specific session ID for the
conversation (must be a valid UUID)." This would allow Yoke to
pre-assign session IDs for tracking purposes.

---

## 5. `--fork-session` flag

**Syntax:** `claude --fork-session -r <session-id> -p "..."`

Per CLI help: "When resuming, create a new session ID instead of reusing
the original (use with --resume or --continue)." This could be useful for
Yoke's retry semantics — forking a failed session to retry with the same
context but a new session ID.

Not tested.

---

## 6. Recommendations for Yoke

### Session continuation in pipelines

For Yoke's multi-phase pipeline model where phases may need to continue
a prior session:

1. **Capture `session_id`** from the `system.init` event of the spawned
   session.
2. **Store it** in the `sessions.session_id` column (SQLite schema).
3. **Resume via `-r <session-id>`**, never via `-c`.
4. **Detect continuation** in stream-json by comparing the `system.init`
   session_id against the spawned session's known ID.

### Pre-assigned session IDs

Consider using `--session-id <uuid>` when spawning sessions. This lets
Yoke assign the session ID before the child process starts, simplifying
the tracking pipeline (no need to wait for the first event to know the
session ID).

### Session persistence

Default `--print` mode persists sessions. If Yoke manages its own
session log (via the raw JSONL capture in `.yoke/logs/`), consider
passing `--no-session-persistence` to avoid duplicate storage. However,
keeping Claude Code's own persistence enables `-r` resume, which is
valuable for retry and continuation.

### Race condition with `-c`

If a user runs `claude` interactively in the same directory where Yoke
sessions are running, `-c` becomes ambiguous. Yoke MUST use `-r` with
explicit session IDs. This is not a theoretical risk — it was observed
in this research.

---

## 7. Capture files

| File | Purpose | Lines |
|---|---|---|
| `/tmp/yoke-capture-3a.jsonl` | "Remember 42" session | 11 |
| `/tmp/yoke-capture-3b.jsonl` | `-c` continue (wrong session) | 5 |
| `/tmp/yoke-capture-3c.jsonl` | `-r` resume (correct session) | 4 |

Internal session file examined:
```
~/.claude/projects/-Users-jforsythe-dev-ai-yoke/b9dbb534-8a48-42e0-b44d-228ceed22504.jsonl
```
