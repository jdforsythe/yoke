# Yoke — Architecture

Source of truth: `docs/idea/plan-draft3.md`. This doc is the design projection
of the plan's §Architecture, §Worktree Management, §Process Management,
§SQLite Schema, and §Configuration sections into concrete module boundaries,
directory layout, and process topology. It does not introduce scope; anything
not in plan-draft3 belongs in `open-questions.md`.

No `architecture.md` exists at the repo root (checked 2026-04-11). Per D54,
when a root `architecture.md` is introduced later, updates land in
`architecture-proposed.md` instead of overwriting.

---

## 1. Module graph

```
 ┌──────────────┐     ┌──────────────────┐     ┌───────────────┐
 │   CLI        │     │  HTTP + WS API   │     │  Dashboard UI │
 │ (commander)  │     │    (fastify+ws)  │     │  (react+vite) │
 └──────┬───────┘     └─────────┬────────┘     └───────┬───────┘
        │                       │                      │
        │     ┌─────────────────▼──────────────────┐   │
        │     │         Pipeline Engine            │◀──┘
        └────▶│   (state machine, transitions,     │
              │    retry ladder, failure classif.) │
              └─┬───────┬──────┬──────┬────────┬───┘
                │       │      │      │        │
        ┌───────▼──┐ ┌──▼──┐ ┌─▼────┐ ┌▼─────┐ ┌▼───────────┐
        │ Process  │ │Wrk- │ │Pre/  │ │Prompt│ │ Notify +   │
        │ Manager  │ │tree │ │Post  │ │ Asm. │ │ GitHub     │
        │(command- │ │ Mgr │ │Runner│ │(pure)│ │ adapters   │
        │ agnostic)│ │     │ │      │ │      │ │            │
        └────┬─────┘ └──┬──┘ └──┬───┘ └──┬───┘ └────────────┘
             │          │       │        │
             ▼          ▼       ▼        ▼
    ┌────────────────────────────────────────────┐
    │          Storage layer (SQLite)            │
    │  workflows · items · sessions · events     │
    │  artifact_writes · pending_attention       │
    │  schema_migrations        (WAL, single DB) │
    └────────────────────────────────────────────┘
             │
             ▼
    ┌────────────────────────┐
    │   Session Log Store    │
    │   .yoke/logs/*.jsonl   │
    │   (survives worktree   │
    │    cleanup)            │
    └────────────────────────┘
```

The Pipeline Engine is the only component that mutates SQLite state.
Dashboard reads go through a separate read-only connection
(plan-draft3 §SQLite Schema). No long-lived in-memory representation of
workflow/item state exists outside a single transaction's scope
(plan-draft3 §Core Design Principles #6, D03).

---

## 2. Directory layout (src/, Phase δ)

```
src/
  server/
    main.ts                    # process entry, fastify bootstrap
    config/
      loader.ts                # YAML + ajv + file-path validation
      resolve.ts               # merge defaults, resolve paths
    state-machine/
      states.ts                # State / Event unions
      transitions.ts           # const TRANSITIONS (§State Machine)
      classifier.ts            # transient|permanent|policy|unknown
    pipeline/
      engine.ts                # read SQLite → compute event → transition
      retry-ladder.ts          # continue|fresh_with_failure_summary|...
      action-runner.ts         # executes post-command action grammar
    process/
      manager.ts               # ProcessManager interface (§Testability)
      jig-manager.ts           # concrete: spawn(cfg.command, cfg.args)
      scripted-manager.ts      # replays recorded stream-json fixtures
      stream-json.ts           # NDJSON line-buffered parser
      heartbeat.ts             # liveness + stream-activity signals
    prepost/
      runner.ts                # Pre/Post command runner (§Phase Pre/Post)
      action-grammar.ts        # exit-code → action map evaluator
    worktree/
      manager.ts               # create, bootstrap, teardown, cleanup
      branch.ts                # yoke/<name>-<shortid> allocator
    prompt/
      context.ts               # PromptContext builder (D11)
      assembler.ts             # pure (template, ctx) → string
      engine.ts                # hand-rolled {{name}} replacer
    storage/
      db.ts                    # better-sqlite3 pool (writer + readers)
      migrations/              # 0001_*.sql, 0002_*.sql, ...
      models/                  # typed wrappers, zero ORM
    session-log/
      writer.ts                # per-session .jsonl writer
      reader.ts                # HTTP paging endpoint backing store
    api/
      http.ts                  # fastify routes (snapshot, timeline, ...)
      ws.ts                    # envelope, subscribe/ack, backfill
      frames.ts                # ServerFrame / ClientFrame types
    github/
      octokit.ts               # auto-PR path
      gh.ts                    # gh CLI fallback + auth order
    notifications/
      service.ts               # info | requires_attention dispatch
      browser-push.ts
      macos.ts                 # node-notifier
      pending-attention.ts     # SQLite-backed banner source
    runtime/
      keep-awake.ts            # caffeinate / systemd-inhibit child
    cli/
      init.ts
      start.ts
      status.ts
      cancel.ts
      doctor.ts
      record.ts
  client/
    app.tsx
    ws/                        # socket multiplexer, seq/ack, backfill
    store/                     # normalized render model (D18)
    components/
      WorkflowList/
      FeatureBoard/
      LiveStream/              # tanstack-virtual virtualized pane
      ReviewPanel/             # Task tool fan-out specialization
      ControlMatrix/           # (workflow × feature × session) rules
      GithubButton/
      AttentionBanner/
      CrashRecoveryBanner/
      SystemNotice/
docs/
  design/                      # ← this directory
```

---

## 3. Process topology

A Yoke instance is exactly one Node process serving one user on 127.0.0.1
(D57). Children:

| Child                                | Lifetime                    | Pgid?  |
|---|---|---|
| Agent session (per phase)            | phase duration              | yes (detached, own process group) |
| `pre:` / `post:` command             | command duration (≤ 15 min) | yes |
| Worktree bootstrap / teardown        | bootstrap/teardown phase    | yes |
| `keep_awake` helper (optional, D60)  | workflow duration           | yes |
| Fastify HTTP + ws listener           | instance lifetime           | in-process |

Shutdown order (plan-draft3 §Process Management, §Crash Recovery):

1. SIGTERM each tracked child process group.
2. 10 s grace.
3. SIGKILL stragglers.
4. fsync SQLite (WAL).
5. Exit.

All children inherit correlation env: `YOKE_WORKFLOW_ID`, `YOKE_ITEM_ID`,
`YOKE_STAGE`, `YOKE_PHASE`, `YOKE_SESSION_ID`, `YOKE_ATTEMPT`.

---

## 4. Module responsibilities (one page each)

### 4.1 Pipeline Engine
- Inputs: SQLite state, stage list from `.yoke/templates/*.yml` (Issue 1), events
  from Process Manager, Pre/Post Runner, Worktree Manager.
- Outputs: SQLite writes, side-effect calls to Process / Worktree / Prompt
  modules, WebSocket `workflow.update` / `item.update` frames.
- Responsibilities:
  - Manage stage sequencing: advance workflows through the ordered stage
    list, reading item manifests when entering `per-item` stages (Issue 1).
  - For `per-item` stages: read the manifest via `items_from`, extract
    items via `items_list` / `items_id`, store opaque item data in SQLite,
    resolve dependency ordering via `items_depends_on` (Issue 2).
  - Resolve next event from observed input using failure classifier.
  - Look up `(state, event)` in `transitions.ts`; apply guard; commit
    transition inside a single SQLite transaction; emit the corresponding
    `event` row in the `events` table.
  - Drive the outer retry ladder (§Retry).
  - Enforce the `max_revisits` loop guard when a `post:` action is `goto`.
  - Advance items through phases within a stage; detect stage completion
    (all items terminal) and trigger the next stage.
- Non-responsibilities: not the NDJSON parser, not the child spawner, not
  the template interpolator, not the artifact validator, not the review
  aggregator (Issue 4 — review pass/fail is determined by `post:` commands,
  not by harness-level file parsing).
- Guarantees: SQLite row is canonical; every transition is durable before
  any external-visible side effect (D03, §Crash Recovery).

### 4.2 Process Manager
- Command-agnostic (D55): `spawn(cfg.command, cfg.args)`.
- Owns: `detached:true` process group, stdin prompt buffer, NDJSON parser,
  stderr capture with cap, heartbeat, exit/error event emission, liveness
  probe for crash recovery (`kill(pid, 0)`).
- Two implementations:
  - `JigProcessManager` — production name kept for continuity but spawns
    whatever command the user configured; jig is not required.
  - `ScriptedProcessManager` — replays captured stream-json JSONL + exit
    codes + stderr for `yoke record` fixtures (§Testability).
- Never mutates SQLite directly. Emits typed events consumed by the
  Pipeline Engine.

### 4.3 Pre/Post Command Runner
- Runs arrays of `{name, run, actions}` commands before/after the agent
  session for a phase (§Phase Pre/Post Commands).
- Spawns with `spawn(cmd, args, {shell:false})` in the worktree CWD.
- Enforces per-command wall-clock timeout (default 15 min).
- Streams stdout/stderr to the Session Log Store and emits
  `prepost.command.*` WS frames.
- Resolves exit code to an action via `action-grammar.ts`; hands the
  resolved action up to the Pipeline Engine to execute.
- Action execution (goto / retry / stop / fail) lives in the Pipeline
  Engine, not in the runner.

### 4.4 Worktree Manager
- Create `yoke/<name>-<shortid>` branch + worktree under `.worktrees/`.
- Run `bootstrap.commands` as its own state-machine phase (a
  `bootstrap_failed` state is terminal until the user acts, §Worktree).
- Expose `.yoke/teardown.sh` hook invocation before `git worktree remove`.
- Ordered cleanup: kill tracked pids → teardown → `git worktree remove
  --force` → branch retention decision.
- Refuses auto-cleanup if the branch has unpushed commits without a PR.

### 4.5 Session Log Store
- Append-only per-session JSONL files under
  `~/.yoke/<fingerprint>/logs/<workflow-id>/<session-id>.jsonl`
  (Q-session-log-directory-collisions resolution).
- Written by the Process Manager (stream-json line copy) and the
  Pre/Post Runner (command output frames).
- Read by the HTTP paging endpoint (`GET /api/sessions/:id/log`) and the
  WebSocket backfill path.
- Lifetime independent of the worktree (D04). Retention governed by
  `retention.stream_json_logs`.

### 4.6 Prompt Assembler (pure)
- Pure function `(template, PromptContext) → string` (D11).
- PromptContext is constructed by the Pipeline Engine from:
  Worktree Manager (file reads), SQLite (item row with opaque `data`
  blob + harness state, handoff entries, recent diff via `simple-git`),
  configuration, git log. Injects `{{item}}` (opaque user data) and
  `{{item_state}}` (harness-tracked state) for per-item phases (Issue 3).
- No I/O inside the assembler; enables dry-run preview and unit testing.

### 4.7 Config Loader
- Reads template files from `.yoke/templates/*.yml` (YAML 1.2), validates
  against `schemas/yoke-config.schema.json`, resolves relative paths at load
  time (prompt templates, artifact schemas, hooks).
- Exposes two public functions: `listTemplates(configDir)` for the UI picker
  and `loadTemplate(configDir, name)` for full validation + path resolution.
- Rejects unknown keys (`additionalProperties: false` everywhere).
- Throws `migration_error` if a root `.yoke.yml` is found — it must be moved
  to `.yoke/templates/<name>.yml` first.
- Produces a typed `ResolvedConfig` that downstream modules consume.
- The `template.name` field (from the YAML) is stored in the workflow row as
  `template_name` and is informational only — it does not drive dedup or resumption.

### 4.8 Storage layer
- `better-sqlite3` single writer, separate read-only connections for the
  dashboard (§SQLite Schema).
- PRAGMAs set once at open: `journal_mode=WAL`, `synchronous=NORMAL`,
  `foreign_keys=ON`.
- Forward-only SQL migrations in `migrations/`, applied inside a
  transaction at startup.
- Every transition wrapped in `db.transaction(fn)()`.

### 4.9 API layer
- HTTP: workflow list (keyset pagination), timeline, session log paging,
  usage aggregates, manual controls with `commandId` idempotency.
- WebSocket: single multiplexed socket per client; envelope with
  per-session `seq`; explicit `hello` with protocol version.
- Protocol details in `protocol-websocket.md`.

---

## 5. Data flow — a single phase within a per-item stage

1. Pipeline Engine reads `workflow`+`item` rows; `(ready,
   phase_start)` → `bootstrapping` → `in_progress` (single transaction).
2. Worktree Manager creates worktree + branch (first phase of first
   per-item stage only), runs bootstrap commands.
3. Pipeline Engine builds `PromptContext` including `{{item}}` (opaque
   user data from `items.data`) and `{{item_state}}` (harness state
   from `items` columns). Calls Prompt Assembler (Issue 2, Issue 3).
4. Pre/Post Runner executes `pre:` commands; a fail branches per action.
5. Process Manager `spawn(cmd, args)`, streams stdin buffer, parses stdout
   NDJSON line-by-line, captures stderr, emits typed events.
6. On child exit, Process Manager raises `session_ok` / `session_fail`.
7. Pre/Post Runner executes `post:` commands sequentially; each maps exit
   code → action; the Pipeline Engine executes the action. For a review
   phase, pass/fail is determined here by user-configured post commands,
   not by harness-level review aggregation (Issue 4).
8. Artifact validators (ajv) run against declared `output_artifacts`.
9. Item manifest diff check rejects disallowed writes to the `items_from`
   file (§File Contract, D10).
10. If more phases remain in the current stage, the Pipeline Engine
    advances `current_phase` and re-enters at step 3 for the next phase.
    If this was the last phase, the item enters `complete` and the
    Pipeline Engine checks for stage completion (Issue 1).

---

## 6. Trust boundaries

- Untrusted: spec content, item manifest content, agent-produced files.
- Trusted: harness code, `.yoke/templates/*.yml` (user-authored), the user's own
  Claude hooks.
- Enforcement of the untrusted→trusted boundary is opt-in (`post:`
  commands + safety templates). See `threat-model.md`.

---

## 7. Templates vs workflow instances

A **template** is a static YAML file under `.yoke/templates/` that declares
the pipeline shape, phases, commands, and prompt files. Templates have a
`template.name` field (informational, used in the UI picker) and an optional
`description`. One template file can be used to create many workflow instances.

A **workflow instance** is a SQLite row (`workflows` table) with:
- A user-supplied `name` (set at creation via the UI or API).
- A `template_name` column (denormalized from `config.template.name`, informational only).
- Its own `id` (UUID), `status`, `paused_at`, `branch_name`, `worktree_path`.

Workflow instances are created via `POST /api/workflows` (the UI picker) by:
1. Selecting a template from `GET /api/templates`.
2. Entering a workflow name (e.g. "add-auth-v2").
3. The server calls `createWorkflow(db, config, {name})` which inserts the row.

**Key invariant:** a template file can be edited at any time without affecting
running or paused workflow instances. The scheduler reads the resolved config
at startup; running instances use the config snapshot stored at creation.

---

## 8. Startup-pause behavior

When `yoke start` is invoked, the Scheduler applies a **startup pause** before
beginning its tick loop:

1. All non-terminal workflows (`status NOT IN (completed, abandoned,
   completed_with_blocked)`) with `paused_at IS NULL` have `paused_at` set to
   `datetime('now')`.
2. The tick loop begins. Workflows where `paused_at IS NOT NULL` are skipped
   (via the `idx_workflows_paused_at` partial index added by migration 0005).
3. The user views the dashboard, selects a workflow, and clicks **Continue** in
   the PausedBanner. This calls `POST /api/workflows/:id/control` with
   `{action: "continue"}`, which clears `paused_at` and allows the tick loop to
   pick up the workflow on the next cycle.

This design ensures no workflow auto-resumes after a server restart without
explicit user intent, which is important when multiple templates are in use and
the user may want to inspect or adjust a workflow before continuing.

To skip the startup pause (e.g. in tests or automated pipelines), pass
`skipStartupPause: true` to the `Scheduler` constructor.
