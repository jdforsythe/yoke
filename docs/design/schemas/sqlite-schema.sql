-- Yoke — SQLite schema (final DDL)
-- Source: plan-draft3.md §SQLite Schema (D38), §File Contract (D10, D12),
-- §Crash Recovery (D27), §Phase Pre/Post Commands (D50).
--
-- Discipline:
--   * single writer (better-sqlite3), readers use a separate connection
--   * every state transition wrapped in db.transaction(fn)()
--   * WAL mode, normal sync, foreign keys on
--   * forward-only migrations; this file represents the target state,
--     individual migration files live under src/server/storage/migrations/

-- ---------------------------------------------------------------------------
-- PRAGMAs (set on every connection open, both writer and reader)
-- ---------------------------------------------------------------------------
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;
-- Recommended for long-running orchestrator:
--   busy_timeout lets readers wait briefly instead of instant SQLITE_BUSY.
PRAGMA busy_timeout = 5000;
-- WAL autocheckpoint is fine at default; document for ops in retention config.

-- ---------------------------------------------------------------------------
-- Migrations bootstrap
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS schema_migrations (
  version    INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);

-- ---------------------------------------------------------------------------
-- workflows — one row per named workflow run.
-- ---------------------------------------------------------------------------
CREATE TABLE workflows (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  spec            TEXT NOT NULL,      -- the user-provided spec (text/markdown)
  pipeline        TEXT NOT NULL,      -- JSON: resolved phase graph (nodes+edges)
  config          TEXT NOT NULL,      -- JSON: resolved .yoke.yml
  status          TEXT NOT NULL,      -- matches state-machine state labels
  worktree_path   TEXT,
  branch_name     TEXT,
  recovery_state  TEXT,               -- JSON; set on restart, cleared on ack
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE INDEX idx_workflows_status ON workflows(status);
CREATE INDEX idx_workflows_created_at ON workflows(created_at DESC);
-- idx_workflows_created_at supports keyset pagination in GET /api/workflows.

-- ---------------------------------------------------------------------------
-- features — canonical feature store. features.json is a projection.
-- ---------------------------------------------------------------------------
CREATE TABLE features (
  id                          TEXT PRIMARY KEY,
  workflow_id                 TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  feature_data                TEXT NOT NULL,   -- JSON: canonical feature object
                                               --   per features.schema.json
  status                      TEXT NOT NULL,   -- state-machine label
  current_phase               TEXT,            -- free-text (D05)
  depends_on                  TEXT NOT NULL,   -- JSON array of feature ids
  retry_count                 INTEGER NOT NULL DEFAULT 0,
  retry_window_start          TEXT,            -- for exponential-backoff window (D07)
  created_by_session_id       TEXT,            -- provenance (D12)
  last_updated_by_session_id  TEXT,
  blocked_reason              TEXT,
  updated_at                  TEXT NOT NULL
);
CREATE INDEX idx_features_workflow ON features(workflow_id);
CREATE INDEX idx_features_status ON features(workflow_id, status);
-- (Ambiguity note: plan-draft3 names idx_sessions_feature in §SQLite Schema D38
-- but that index is better attached to the sessions table below; included there.)

-- ---------------------------------------------------------------------------
-- sessions — one row per spawned agent session (plan, implement, review, ...).
-- ---------------------------------------------------------------------------
CREATE TABLE sessions (
  id                          TEXT PRIMARY KEY,
  workflow_id                 TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  feature_id                  TEXT REFERENCES features(id) ON DELETE SET NULL,
  parent_session_id           TEXT REFERENCES sessions(id),
  -- parent_session_id exists to chain -c continuation sessions so that
  -- per-session usage is the delta from a single spawn and per-feature
  -- usage sums the chain (plan-draft3 §stream-json parsing, D16).
  phase                       TEXT NOT NULL,           -- free-text label
  agent_profile               TEXT NOT NULL,
  pid                         INTEGER,
  pgid                        INTEGER,
  started_at                  TEXT NOT NULL,
  ended_at                    TEXT,
  exit_code                   INTEGER,
  -- Token usage as columns (D39) plus raw_usage as an opaque escape hatch
  -- for any extra fields that arrive on a Phase γ verification pass.
  input_tokens                INTEGER NOT NULL DEFAULT 0,
  output_tokens               INTEGER NOT NULL DEFAULT 0,
  cache_creation_input_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_input_tokens     INTEGER NOT NULL DEFAULT 0,
  raw_usage                   TEXT,
  session_log_path            TEXT,             -- .yoke/logs/<id>.jsonl
  status                      TEXT NOT NULL,    -- running|ok|fail|cancelled|tainted
  status_flags                TEXT,             -- JSON: {parse_errors, tainted, ...}
  last_event_at               TEXT,
  last_event_type             TEXT
);
CREATE INDEX idx_sessions_workflow ON sessions(workflow_id, feature_id);
CREATE INDEX idx_sessions_feature ON sessions(feature_id);
CREATE INDEX idx_sessions_parent ON sessions(parent_session_id);

-- ---------------------------------------------------------------------------
-- events — append-only state-machine + harness debug trace (D38).
-- ---------------------------------------------------------------------------
CREATE TABLE events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ts          TEXT NOT NULL,
  workflow_id TEXT REFERENCES workflows(id) ON DELETE CASCADE,
  feature_id  TEXT REFERENCES features(id) ON DELETE SET NULL,
  session_id  TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  phase       TEXT,
  attempt     INTEGER,
  event_type  TEXT NOT NULL,
  level       TEXT NOT NULL,   -- debug|info|warn|error
  message     TEXT NOT NULL,
  extra       TEXT             -- JSON
);
CREATE INDEX idx_events_workflow ON events(workflow_id, ts);
CREATE INDEX idx_events_session ON events(session_id, ts);
CREATE INDEX idx_events_type ON events(event_type);

-- ---------------------------------------------------------------------------
-- artifact_writes — provenance trail for every file written by a session.
-- Populated by the Process Manager on session end via a worktree diff scan
-- and by the Pre/Post Runner for command-produced files.
-- ---------------------------------------------------------------------------
CREATE TABLE artifact_writes (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id    TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  artifact_path TEXT NOT NULL,
  written_at    TEXT NOT NULL,
  sha256        TEXT NOT NULL
);
CREATE INDEX idx_artifact_writes_session ON artifact_writes(session_id);
CREATE INDEX idx_artifact_writes_path ON artifact_writes(artifact_path);

-- ---------------------------------------------------------------------------
-- pending_attention — authoritative source for the dashboard attention banner
-- (D49). Populated when a workflow enters awaiting_user / blocked / crash
-- recovery / rate_limited-with-no-resume. Cleared on user acknowledgement.
-- ---------------------------------------------------------------------------
CREATE TABLE pending_attention (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  workflow_id     TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  kind            TEXT NOT NULL,
  -- kind examples: blocked_feature, crash_recovery_required,
  --                rate_limited_long, review_invalid_limit,
  --                post_command_fail, awaiting_user_retry
  payload         TEXT NOT NULL,   -- JSON
  created_at      TEXT NOT NULL,
  acknowledged_at TEXT
);
CREATE INDEX idx_pending_attention_workflow ON pending_attention(workflow_id);
CREATE INDEX idx_pending_attention_open ON pending_attention(workflow_id) WHERE acknowledged_at IS NULL;

-- ---------------------------------------------------------------------------
-- prepost_runs — per-command execution record (D50). One row per command
-- per phase attempt. Comment: not in plan-draft3 §SQLite Schema; added here
-- because plan-draft3 §v1 Acceptance scenario 3 requires observable evidence
-- that a declared action was applied, which requires per-command rows.
-- If this is a scope addition it goes on open-questions.md; the architect
-- flags it below (see open-questions.md §Q-prepost-table).
-- ---------------------------------------------------------------------------
CREATE TABLE prepost_runs (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id   TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  workflow_id  TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  feature_id   TEXT REFERENCES features(id) ON DELETE SET NULL,
  phase        TEXT NOT NULL,
  when_phase   TEXT NOT NULL CHECK (when_phase IN ('pre', 'post')),
  command_name TEXT NOT NULL,
  argv         TEXT NOT NULL,   -- JSON array
  started_at   TEXT NOT NULL,
  ended_at     TEXT,
  exit_code    INTEGER,
  action_taken TEXT,            -- JSON: resolved action object
  stdout_path  TEXT,
  stderr_path  TEXT
);
CREATE INDEX idx_prepost_workflow ON prepost_runs(workflow_id, started_at);
CREATE INDEX idx_prepost_session ON prepost_runs(session_id);
