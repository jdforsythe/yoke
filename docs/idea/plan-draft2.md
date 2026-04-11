# Agent Harness — Revised Plan (Draft 2)

## Vision

A configurable orchestration harness that wraps Claude Code (via jig) to enable reliable, long-running, autonomous software development on a Max subscription. It decomposes work into configurable phases, each running as an independent agent session with scoped tools and context. Agents communicate exclusively through file artifacts — not message passing, not shared context. A lightweight server manages the workflow state machine, captures structured logs, and provides a web UI for monitoring and intervention.

The harness is specialized for Claude Code. LLM-agnostic design is a non-goal for v1. If other agents are supported later, they'll need adapters, but the core design optimizes for the Claude Code CLI + jig stack.

---

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│                    Web Dashboard (React)                   │
│  Workflow monitor · Feature board · Streaming agent output │
│  Manual controls · GitHub action buttons · Notifications   │
└──────────────────────┬───────────────────────────────────┘
                       │ WebSocket (streaming output + state)
┌──────────────────────▼───────────────────────────────────┐
│                  Harness Server (Node/TS)                  │
│                                                           │
│  ┌──────────────┐  ┌──────────────┐  ┌────────────────┐  │
│  │  Pipeline     │  │  Process     │  │  Prompt        │  │
│  │  Engine       │  │  Manager     │  │  Assembler     │  │
│  │  (state       │  │  (spawn,     │  │  (template +   │  │
│  │  machine +    │  │  stream,     │  │  stdin pipe)   │  │
│  │  SQLite       │  │  heartbeat)  │  │                │  │
│  │  persistence) │  │              │  │                │  │
│  └──────┬───────┘  └──────┬───────┘  └───────┬────────┘  │
│         │                 │                   │           │
│  ┌──────▼───────┐  ┌─────▼────────┐  ┌───────▼────────┐  │
│  │  Worktree    │  │  Artifact    │  │  State Store   │  │
│  │  Manager     │  │  Store       │  │  (SQLite)      │  │
│  │  (create,    │  │  (logs,      │  │  Workflows +   │  │
│  │  bootstrap,  │  │  tokens,     │  │  phases +      │  │
│  │  cleanup)    │  │  sessions)   │  │  features      │  │
│  └──────────────┘  └──────────────┘  └────────────────┘  │
│                                                           │
│  ┌──────────────┐  ┌──────────────┐                      │
│  │  GitHub      │  │  Notification│                      │
│  │  Integration │  │  Service     │                      │
│  │  (w/ manual  │  │  (fire &     │                      │
│  │  fallback)   │  │  forget)     │                      │
│  └──────────────┘  └──────────────┘                      │
└──────────────────────────────────────────────────────────┘
          │
          │ stdin pipe to child_process
          ▼
┌──────────────────────────────────────────────────────────┐
│              Agent Execution (jig + Claude Code)           │
│                                                           │
│  jig run <profile> -- -p --output-format stream-json      │
│    --dangerously-skip-permissions (configurable)          │
│                                                           │
│  Prompt delivered via stdin pipe                          │
│  Output streamed to harness (stream-json)                 │
│  Hooks enforce quality gates (tests, lint, build, style)  │
│  Subagents handle scoped tasks (tests, review angles)     │
│  All work in isolated git worktrees                       │
│  Communication between phases is through file artifacts   │
└──────────────────────────────────────────────────────────┘
```

---

## Core Design Principles

1. **Agents communicate through files, not messages.** The planner writes `features.json` and `architecture.md`. The implementer reads those and writes code + `progress.md`. The reviewer reads the diff and feature spec and writes `reviews/feature-N.json`. No agent-to-agent messaging. No shared context windows. Each session is independent.

2. **Quality gates live in hooks, not in the harness.** The implementer's Stop hook enforces that tests, lint, build, and style checks pass before the session is considered complete. The harness doesn't redundantly re-run these. The reviewer doesn't redundantly re-run them either.

3. **The harness orchestrates, Claude Code executes.** The harness decides what to do next and whether previous work was good enough. Claude Code (via jig) does the actual work. The harness never touches code.

4. **Specialize for Claude Code.** The jig + Claude Code CLI is the execution layer. Configuration specifies how jig is invoked. If the CLI has breaking changes, the harness releases an update. That's fine.

5. **Token usage is the user's problem.** The harness tracks and reports usage for observability, but does not try to manage or optimize it. If the user runs out of budget, the process pauses naturally (Claude Code's own rate limit behavior). The harness detects this and surfaces it.

---

## Workflow Lifecycle

### Phase 1: Planning

A planner session (fresh context, scoped jig profile — read-only tools).

**Input:** User-provided spec (text/markdown/file).

**Output artifacts:**
- `features.json` — structured features with acceptance criteria and review criteria
- `architecture.md` — technical decisions, dependencies, file structure
- `init.sh` — optional bootstrap script

**Key:** The planner defines acceptance criteria AND review criteria per feature. This prevents the reviewer from rubber-stamping. Review criteria come from two sources: (a) the planner's feature-specific criteria, and (b) the configured review agent definitions (security, complexity, etc.).

**Tools:** Read, Glob, Grep, LS. No Edit, no Bash.

**Harness validates:** `features.json` parses, validates against schema, has >0 features, each has description + acceptance criteria.

### Phase 2: Implementation (per feature)

An implementer session (fresh context, full jig profile).

**Input prompt includes:**
- Feature spec from `features.json`
- `architecture.md`
- `progress.md` (what previous features accomplished)
- Recent git log

**Output:**
- Code changes committed to git
- Updated `progress.md`
- Feature status updated in `features.json`

**Tools:** Read, Edit, Write, Bash, Glob, Grep. MCP servers as configured. Subagents for scoped tasks (e.g., test runner subagent that runs tests in quiet mode and only reports failures back — keeps main context clean).

**Permission mode:** `--dangerously-skip-permissions` by default (configurable in harness config per phase).

**Quality gates via hooks:**
- **Stop hook**: Before the implementer can finish, a hook runs the project's test suite, linter, build, and style checks. If any required check fails, the hook prevents stopping and feeds the failure back to the agent. The agent fixes and tries again.
- This means by the time the implementer "finishes," all automated checks have already passed. The reviewer never redundantly re-runs them.

**Retry loop:** If the implementer's session ends with a failure (hook prevents completion but retries exhaust, or the process dies), the harness uses `-c` (continue session) to send the failure context back. Max retries configurable (default: 3). If retries exhaust, feature is marked `blocked`.

### Phase 3: Review (per feature)

A review team of specialized subagents, each reviewing from a different angle.

**Review agents (configured, not hard-coded):**
- Security reviewer
- Complexity / maintainability reviewer
- Best practices / standards reviewer
- Acceptance criteria verifier
- (User-defined additional reviewers)

Each review agent is a subagent with its own jig profile, scoped tools (Read, Bash for running specific checks, Glob, Grep — no Edit). They receive the feature spec, acceptance criteria, review criteria from the planner, the git diff, and architecture.md.

**Output:** Each subagent writes to `reviews/feature-N/` — one file per reviewer angle. The harness aggregates results.

**Tools:** Read, Bash (scoped), Glob, Grep. No Edit.

**Harness reads reviews:**
- All pass → feature complete
- Any fail → new implementer session with aggregated review notes as context, then re-review
- The review criteria from the planner (acceptance criteria) must be explicitly addressed — each criterion gets a pass/fail verdict

### Completion

All features `complete` or `blocked` → harness runs summary, notifies user, optionally creates PR.

---

## File Contract

### features.json

```json
{
  "project": "project-name",
  "created": "2026-04-10T12:00:00Z",
  "features": [
    {
      "id": "feat-001",
      "category": "auth",
      "description": "User can log in with email and password",
      "priority": 1,
      "depends_on": [],
      "acceptance_criteria": [
        "Login form accepts email and password",
        "Invalid credentials show error message",
        "Successful login redirects to dashboard"
      ],
      "review_criteria": [
        "No credentials stored in plaintext",
        "Rate limiting on login attempts",
        "Input sanitization on all form fields"
      ],
      "status": "pending",
      "blocked_reason": null,
      "implemented_in_commit": null,
      "reviewed": false,
      "review_passed": false
    }
  ]
}
```

Status values: `pending` | `in_progress` | `review` | `complete` | `blocked`

Rules: Agents may only change `status`, `blocked_reason`, and `implemented_in_commit`. They must never add, remove, or rewrite feature descriptions, acceptance criteria, or review criteria.

### progress.md

Free-form markdown updated by each implementer session. Contains what was worked on, what was accomplished, problems encountered, what the next agent should know.

### reviews/feature-N/

One JSON file per review angle:

```json
{
  "feature_id": "feat-001",
  "reviewer": "security",
  "reviewed_commit": "abc1234",
  "verdict": "fail",
  "acceptance_criteria_verdicts": [
    { "criterion": "Login form accepts email and password", "pass": true, "notes": "" },
    { "criterion": "Invalid credentials show error message", "pass": true, "notes": "" },
    { "criterion": "Successful login redirects to dashboard", "pass": false, "notes": "Redirect targets /home not /dashboard" }
  ],
  "review_criteria_verdicts": [
    { "criterion": "No credentials stored in plaintext", "pass": true, "notes": "" },
    { "criterion": "Rate limiting on login attempts", "pass": false, "notes": "No rate limiting implemented" },
    { "criterion": "Input sanitization on all form fields", "pass": true, "notes": "" }
  ],
  "additional_issues": [
    {
      "severity": "high",
      "category": "security",
      "description": "Password comparison uses timing-unsafe equality",
      "file": "src/auth/login.ts",
      "suggestion": "Use crypto.timingSafeEqual or bcrypt.compare"
    }
  ]
}
```

---

## Hooks Integration

The harness relies on Claude Code hooks for enforcing quality gates within agent sessions. These are configured in the project's `.claude/hooks` and referenced by jig profiles.

### Implementer Stop Hook

```json
{
  "hooks": {
    "Stop": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": ".claude/hooks/require-passing-checks.sh"
          }
        ]
      }
    ]
  }
}
```

```bash
#!/bin/bash
# .claude/hooks/require-passing-checks.sh
# Prevents the implementer from stopping until all checks pass.

FAILURES=""

# Run checks (quiet mode — only output failures)
if ! pnpm run typecheck 2>&1 | tail -20; then
  FAILURES="$FAILURES\n- TypeScript errors found"
fi

if ! pnpm run lint --quiet 2>&1 | tail -20; then
  FAILURES="$FAILURES\n- Lint errors found"
fi

if ! pnpm run test --reporter=dot 2>&1 | tail -20; then
  FAILURES="$FAILURES\n- Test failures found"
fi

if ! pnpm run build 2>&1 | tail -5; then
  FAILURES="$FAILURES\n- Build failed"
fi

if [ -n "$FAILURES" ]; then
  echo "Cannot complete — the following checks failed:$FAILURES" >&2
  echo "Fix the issues and try completing again." >&2
  exit 2  # blocks the stop, feeds stderr back to Claude
fi

exit 0
```

This is the key insight: the harness doesn't need a separate "validate" phase. The hook forces the implementer to keep working until the code passes. By the time the harness sees the session end, automated checks have already passed.

### What Hooks Handle vs What the Harness Handles

| Concern | Where it lives |
|---------|---------------|
| Tests must pass before implementation is "done" | Stop hook on implementer |
| Lint/build/style must pass | Stop hook on implementer |
| Dangerous commands blocked | PreToolUse hook |
| Review criteria addressed per-feature | Harness validates review JSON against feature spec |
| Feature status transitions | Harness (reads artifacts, drives state machine) |
| Retry on failure | Harness (uses `-c` to continue session) |
| Process died unexpectedly | Harness (heartbeat + restart) |
| Workflow sequencing | Harness (pipeline engine) |

---

## Worktree Management

Each workflow runs in an isolated git worktree.

### Lifecycle

```
User starts workflow "add-auth"
  │
  ├─► Harness creates worktree (git worktree add or external tool)
  ├─► Runs bootstrap script from config
  ├─► All agent sessions run in the worktree directory
  ├─► Commits land on a branch
  ├─► On completion: harness can create a PR
  └─► Worktree cleaned up (default behavior)
```

### Configuration

```yaml
worktrees:
  base_dir: ".worktrees"
  branch_prefix: "harness/"
  auto_cleanup: true
  cleanup_tool: "git"  # "git" | "lazyworktree" | custom command
  bootstrap:
    commands:
      - "pnpm install"
      # Other projects might need more:
      # - "cp .env.example .env"
      # - "docker compose up -d"
```

The bootstrap is just a list of shell commands. For our monorepo, `pnpm install` is sufficient. Other projects configure what they need. Disk space management is the user's concern.

Cleanup is deterministic. Default is `auto_cleanup: true`. The user can configure an external tool (lazyworktree, a custom script, raw git) to guarantee worktrees get cleaned up properly.

---

## Process Management & Streaming

### Spawning

The harness spawns jig as a child process with stdin piping:

```typescript
const child = spawn('jig', ['run', profile, '--', '-p', '--output-format', 'stream-json', ...extraFlags], {
  cwd: worktreePath,
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env, ...phaseEnv },
});

// Pipe assembled prompt via stdin
const promptStream = createReadStream(promptTempFile);
promptStream.pipe(child.stdin);

// Stream stdout to dashboard via WebSocket
child.stdout.on('data', (chunk) => {
  // Parse stream-json chunks
  // Forward to WebSocket for live UI
  // Store in artifact log
});

child.stderr.on('data', (chunk) => {
  // Capture stderr for error detection
});
```

### Streaming Output to UI

`--output-format stream-json` emits incremental JSON chunks as Claude works. The harness:

1. Parses each chunk
2. Forwards it to the dashboard via WebSocket in real-time
3. The user sees live agent output as it happens
4. User can judge whether the agent is stuck (no need for arbitrary timeouts)

### Heartbeat

The harness monitors each child process:

- **Process alive check**: Is the PID still running? (periodic poll)
- **Output activity**: Has stdout emitted anything in the last N minutes? (configurable, generous default — maybe 5 minutes)
- **Unexpected exit**: `child.on('exit', ...)` handler detects when the process ends

If the process exits unexpectedly (crash, rate limit, etc.):
- The harness logs it
- If the feature is in progress, it can attempt `-c` (continue) to resume
- The dashboard shows the failure state and lets the user decide

### No Arbitrary Timeouts

Timeouts are dangerous — a process might legitimately be doing a long build, running a large test suite, or reading many files. Killing a live agent mid-work creates a mess. Instead:

- Stream output so the user can see what's happening
- Heartbeat to detect unexpected death
- User-initiated cancel as the escape hatch

---

## Crash Recovery

### On Harness Exit

When the harness Node process receives SIGTERM/SIGINT:

1. Persist current workflow state to SQLite (should already be current — we persist on every transition)
2. Send SIGTERM to all child agent processes
3. Wait briefly for graceful shutdown
4. Exit

### On Harness Restart

1. Load workflow state from SQLite
2. For any workflow that was `in_progress`:
   - Check if the worktree exists and has uncommitted changes
   - Attempt to resume with `claude -c` (continue last session in that directory)
   - If that fails, start a fresh session for the interrupted phase with context about what was in progress
3. Surface the recovered state in the dashboard

### State Persistence

Every state transition is persisted to SQLite before the transition takes effect:

```sql
CREATE TABLE workflows (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  spec TEXT NOT NULL,
  pipeline TEXT NOT NULL,        -- JSON: phase sequence
  config TEXT NOT NULL,          -- JSON: resolved config
  status TEXT NOT NULL,          -- pending | running | paused | completed | failed
  worktree_path TEXT,
  branch_name TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE features (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL REFERENCES workflows(id),
  feature_data TEXT NOT NULL,     -- JSON: the feature object from features.json
  status TEXT NOT NULL,
  current_phase TEXT,
  retry_count INTEGER DEFAULT 0,
  updated_at TEXT NOT NULL
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL REFERENCES workflows(id),
  feature_id TEXT REFERENCES features(id),
  phase TEXT NOT NULL,
  agent_profile TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  exit_code INTEGER,
  token_usage TEXT,              -- JSON: {input, output, cache_read, cache_write}
  session_log_path TEXT,         -- path to the JSONL/stream-json capture
  status TEXT NOT NULL           -- running | completed | failed | cancelled
);
```

---

## Configuration

```yaml
# .harness.yml

project:
  name: "my-saas-app"

# Pipeline: ordered phase names
pipeline:
  - plan
  - implement
  - review

# Phase definitions
phases:
  plan:
    profile: "planner"                    # jig profile name
    prompt_template: "prompts/plan.md"
    permission_mode: null                 # inherits from jig profile
    output_artifacts:
      - path: "features.json"
        schema: "schemas/features.schema.json"
        required: true
      - path: "architecture.md"
        required: true
    max_retries: 2

  implement:
    profile: "implementer"
    prompt_template: "prompts/implement.md"
    permission_mode: "bypassPermissions"  # override for this phase
    output_artifacts:
      - path: "progress.md"
        required: true
    max_retries: 3
    retry_mode: "continue"                # use -c to continue session

  review:
    profile: "reviewer"
    prompt_template: "prompts/review.md"
    # Review is a team of subagents — configured in the jig profile
    # and the review prompt template, not in the harness config
    output_artifacts:
      - path: "reviews/feature-{feature_id}/"
        required: true
    on_fail: "implement"
    on_pass: "complete"

# Worktree configuration
worktrees:
  base_dir: ".worktrees"
  branch_prefix: "harness/"
  auto_cleanup: true
  cleanup_tool: "git"
  bootstrap:
    commands:
      - "pnpm install"

# Notifications
notifications:
  enabled: true
  level: "completions_and_errors"
  mechanisms:
    - type: "browser_push"
    - type: "macos_native"

# GitHub integration
github:
  enabled: true
  auto_pr: true
  pr_target_branch: "main"
  attach_artifacts_to_pr: true
  link_issues: true

# Logging & artifacts
logging:
  database: ".harness/harness.db"
  session_logs_dir: ".harness/logs"
  retain_stream_json: true

# UI
ui:
  port: 3456
```

### Prompt Templates

Templates use variable interpolation. Example:

```markdown
# prompts/implement.md

You are implementing a single feature in an existing codebase.

## Feature to implement

{{feature_spec}}

## Architecture constraints

{{architecture_md}}

## Progress so far

{{progress_md}}

## Recent git history

{{git_log_recent}}

## Instructions

1. Read the feature spec carefully.
2. Implement the feature incrementally.
3. Write tests for the feature.
4. Run tests, lint, build, and style checks. Fix any failures.
5. Commit with a descriptive message referencing the feature ID.
6. Update progress.md with what you did.
7. Update the feature status in features.json to "review".
```

---

## Web Dashboard

### Workflow View

- All active/completed workflows with name, status, elapsed time
- Per-workflow: feature list with status indicators (pending / in_progress / review / complete / blocked)
- Current phase per feature with live streaming agent output
- Token usage per session (stored from stream-json output)

### Live Output

The centerpiece of the dashboard. When an agent is running:

- Stream its output in real time (parsed from stream-json)
- Show tool calls, file edits, test runs as they happen
- User can read along and decide if the agent is stuck or making progress
- This replaces arbitrary timeouts

### Controls

- Start new workflow (provide spec, name, target branch)
- Pause / resume / cancel a workflow
- Skip a feature (mark blocked manually)
- Override: re-run any phase for any feature
- Inject context: add notes included in the next agent prompt

### GitHub Actions

When GitHub integration is enabled:

- **Create PR button**: If auto-PR fails or is disabled, user clicks to create via `gh` CLI
- **View PR button**: Opens the PR in browser once created (like Claude Code Desktop does)
- **Create Issue button**: Same pattern — manual fallback with one click
- If auto-PR succeeds, the button appears automatically

### Notifications

Fire-and-forget. If they fail, log it and move on. Never block the workflow.

---

## Usage Tracking

The harness captures token usage from `--output-format stream-json` output and stores it per session:

```json
{
  "input_tokens": 45000,
  "output_tokens": 12000,
  "cache_creation_input_tokens": 8000,
  "cache_read_input_tokens": 35000
}
```

This is stored in the sessions table. Over time, the harness can report:

- Tokens per feature (plan + implement + review)
- Tokens per phase type
- Tokens per agent profile
- Trends over time

This is observability, not management. The harness doesn't throttle or budget tokens. If the user hits rate limits, Claude Code's own behavior handles it (the process pauses or fails, the harness detects it via heartbeat/exit).

### Optional Pre-Step Usage Check

As a configurable option, the harness can check current usage before starting a step:

```yaml
# Optional per-phase usage gate
phases:
  implement:
    usage_gate:
      enabled: false               # opt-in
      max_window_usage_percent: 80  # don't start if >80% of window used
      check_command: "claude --usage --output-format json"
```

This is Claude Code-specific. If enabled, the harness runs the check command, parses the output, and pauses the workflow if usage is above the threshold. The workflow resumes when usage drops (checked periodically).

This is a convenience, not a core feature. Users who don't need it leave it disabled.

---

## Review Architecture (Detail)

The review phase is not a single agent. It's an orchestrator session that spawns specialized subagent reviewers.

### How it works

1. The harness spawns a single reviewer session (the review orchestrator)
2. The review prompt instructs the orchestrator to spawn subagents for each review angle
3. Each subagent has a focused scope (security, complexity, best practices, acceptance criteria)
4. Subagents are defined in the jig profile's agents or in AGENTS.md
5. Each subagent writes its review to a file in `reviews/feature-N/`
6. The orchestrator aggregates and reports the overall verdict

### Why subagents, not separate harness-spawned sessions

- The orchestrator can coordinate which angles to review
- Subagent results return summaries to the orchestrator's context (keeps it efficient)
- The jig profile scopes what each subagent can do
- The harness stays simple — it spawns one session for review, the session handles the rest

### Review agent definitions

Defined as Claude Code agents (in `.claude/agents/` or via jig):

```markdown
# .claude/agents/security-reviewer.md
---
name: security-reviewer
description: Reviews code for security vulnerabilities
tools: Read, Bash, Glob, Grep
model: claude-sonnet-4-6
---

You are a security-focused code reviewer. Review the provided diff for:
- Authentication and authorization issues
- Input validation and sanitization
- Injection vulnerabilities (SQL, XSS, command injection)
- Sensitive data exposure
- Cryptographic weaknesses
...
```

### Preventing rubber-stamping

Two mechanisms:

1. **Planner-defined criteria**: The planner writes `acceptance_criteria` and `review_criteria` per feature. The review prompt requires explicit pass/fail per criterion. A review that doesn't address every criterion is invalid (harness validates the JSON).

2. **Specialized agents steer to different embedding spaces**: A security reviewer with a security-focused system prompt will flag different issues than a general reviewer. The prompt engineering of each review agent is what prevents generic rubber-stamping. Different agents with focused mandates produce genuinely different reviews.

---

## What the Harness Does NOT Do

- **Not rate limit management.** Token budget is the user's concern.
- **Not a replacement for Claude Code.** It orchestrates, doesn't reimplement.
- **Not an IDE.** The dashboard monitors and controls, doesn't edit code.
- **Not LLM-agnostic (v1).** Specialized for Claude Code + jig. Other agents are a future concern.
- **Not a CI/CD system.** Runs locally or on a dev machine. Doesn't deploy.
- **Not timeout-based.** No arbitrary kill timers. Streaming output + heartbeats + user judgment.
- **Not a token optimizer.** Track and report, don't manage.

---

## Requirements

### Must Have (v1)

- [ ] Pipeline engine reading from `.harness.yml`
- [ ] Phase definitions with jig profile, prompt template, output artifacts, and success criteria
- [ ] Spawn jig/claude CLI with stdin-piped prompts
- [ ] Parse `stream-json` output: stream to dashboard, capture token usage, detect exit
- [ ] Parse artifact files (features.json, reviews/) to drive state transitions
- [ ] Retry loop: `-c` to continue session on failure, configurable max retries
- [ ] Worktree management: create, run bootstrap commands, cleanup via configurable tool
- [ ] Named workflows with parallel support (each in its own worktree)
- [ ] Web dashboard: workflow list, feature board, live streaming agent output
- [ ] WebSocket real-time updates
- [ ] Heartbeat monitoring for agent processes (alive check, output activity)
- [ ] Crash recovery: persist workflow state to SQLite on every transition, resume on restart
- [ ] On harness exit: SIGTERM children, persist state
- [ ] On harness restart: detect interrupted workflows, attempt `-c` resume
- [ ] Notifications: browser push + macOS native (fire and forget)
- [ ] Prompt template system with variable interpolation
- [ ] Default pipeline config and prompt templates for plan → implement → review
- [ ] CLI: `harness start`, `harness status`, `harness cancel`, `harness init`

### Should Have (v1.1)

- [ ] GitHub integration: auto PR creation with manual fallback button
- [ ] GitHub integration: View PR / View Issue buttons in dashboard
- [ ] GitHub integration: attach artifacts to PRs, link issues
- [ ] Feature dependency ordering (topological sort of `depends_on`)
- [ ] Token usage reporting: per-feature, per-phase, trends over time
- [ ] Session log storage and searchable log viewer in dashboard
- [ ] Iterative planning: plan in batches, replan after each batch
- [ ] Webhook notifications (Slack, Discord)
- [ ] Export workflow report (features completed, tokens, blocked items)
- [ ] Context injection: user adds notes via dashboard for next agent prompt
- [ ] Optional pre-step usage gate (check claude --usage before starting)

### Nice to Have (v2)

- [ ] Log analysis: failure pattern detection across sessions
- [ ] Automatic CLAUDE.md / prompt template suggestions from analysis
- [ ] Cross-project pattern analysis
- [ ] Plugin system for custom validators between phases
- [ ] Electron wrapper
- [ ] GitHub issue → workflow automation
- [ ] Channels integration (forward permission prompts to phone)

---

## Tech Stack

| Component | Technology | Rationale |
|-----------|-----------|-----------|
| Harness server | Node.js / TypeScript | Native child_process, same language as UI |
| Pipeline engine | Custom state machine + SQLite | Simple, sufficient for v1 pipeline shapes |
| Web UI | React + Vite + Tailwind | Fast dev, WebSocket support, streaming output display |
| HTTP + WebSocket server | Fastify + ws | Fast, good TS support |
| State + log storage | SQLite via better-sqlite3 | Synchronous API, WAL for concurrent reads, zero config |
| Git operations | simple-git + raw git commands | Worktree management, log, diff |
| Notifications | node-notifier + Web Notifications API | Cross-platform native + browser |
| GitHub | Octokit + gh CLI fallback | API client + manual fallback via CLI |
| Config | yaml + ajv | YAML config with JSON Schema validation |
| CLI | commander | Standard Node.js CLI framework |
| Agent execution | jig (→ Claude Code) | Profile management, tool scoping, plugin management |

---

## Build Order

### Phase 1: Core engine (2-3 weeks)

1. Config parser (YAML + schema validation for `.harness.yml`)
2. SQLite state store (workflows, features, sessions tables)
3. Pipeline engine (state machine: load config → create worktree → run phases → cleanup)
4. Prompt assembler (read template, interpolate variables, write temp file)
5. Process manager (spawn jig with stdin pipe, capture stream-json, heartbeat)
6. Worktree manager (create, bootstrap, cleanup)
7. Artifact validators (JSON schema check on features.json and review files)
8. CLI (`harness start <spec>`, `harness status`, `harness cancel <id>`)
9. Default prompt templates

### Phase 2: Dashboard (1-2 weeks)

1. Fastify server with WebSocket
2. React app: workflow list, feature board, phase status
3. Live streaming agent output via WebSocket
4. Manual controls (pause, cancel, skip, re-run)
5. Notifications (browser push + macOS native)

### Phase 3: Polish (1 week)

1. Crash recovery (SIGTERM handler, restart detection, `-c` resume)
2. `harness init` scaffolding command
3. Error messages and user guidance
4. README, config guide, prompt template guide

### Phase 4: GitHub + reporting (v1.1, 1-2 weeks)

1. GitHub PR creation (auto + manual fallback button)
2. View PR / View Issue buttons
3. Artifact attachment to PRs
4. Token usage reporting in dashboard
5. Session log viewer