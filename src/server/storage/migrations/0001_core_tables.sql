-- Migration 0001 — core tables
-- Defines all seven operational tables with indexes and FK semantics.
-- schema_migrations is bootstrapped by openDbPool before this runs.
-- PRAGMAs (WAL, synchronous, foreign_keys, busy_timeout) are set by
-- openDbPool on every connection open, not in migration files.

-- ---------------------------------------------------------------------------
-- workflows — one row per named workflow run.
-- ---------------------------------------------------------------------------
CREATE TABLE workflows (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  spec            TEXT NOT NULL,
  pipeline        TEXT NOT NULL,
  config          TEXT NOT NULL,
  status          TEXT NOT NULL,
  current_stage   TEXT,
  worktree_path   TEXT,
  branch_name     TEXT,
  recovery_state  TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE INDEX idx_workflows_status ON workflows(status);
CREATE INDEX idx_workflows_created_at ON workflows(created_at DESC);

-- ---------------------------------------------------------------------------
-- items — canonical item store. Item data is opaque to the harness.
-- ---------------------------------------------------------------------------
CREATE TABLE items (
  id                          TEXT PRIMARY KEY,
  workflow_id                 TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  stage_id                    TEXT NOT NULL,
  data                        TEXT NOT NULL,
  status                      TEXT NOT NULL,
  current_phase               TEXT,
  depends_on                  TEXT,
  retry_count                 INTEGER NOT NULL DEFAULT 0,
  retry_window_start          TEXT,
  created_by_session_id       TEXT,
  last_updated_by_session_id  TEXT,
  blocked_reason              TEXT,
  updated_at                  TEXT NOT NULL
);
CREATE INDEX idx_items_workflow ON items(workflow_id);
CREATE INDEX idx_items_status ON items(workflow_id, status);
CREATE INDEX idx_items_stage ON items(workflow_id, stage_id);

-- ---------------------------------------------------------------------------
-- sessions — one row per spawned agent session.
-- ---------------------------------------------------------------------------
CREATE TABLE sessions (
  id                          TEXT PRIMARY KEY,
  workflow_id                 TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  item_id                     TEXT REFERENCES items(id) ON DELETE SET NULL,
  parent_session_id           TEXT REFERENCES sessions(id),
  stage                       TEXT NOT NULL,
  phase                       TEXT NOT NULL,
  agent_profile               TEXT NOT NULL,
  pid                         INTEGER,
  pgid                        INTEGER,
  started_at                  TEXT NOT NULL,
  ended_at                    TEXT,
  exit_code                   INTEGER,
  input_tokens                INTEGER NOT NULL DEFAULT 0,
  output_tokens               INTEGER NOT NULL DEFAULT 0,
  cache_creation_input_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_input_tokens     INTEGER NOT NULL DEFAULT 0,
  raw_usage                   TEXT,
  session_log_path            TEXT,
  status                      TEXT NOT NULL,
  status_flags                TEXT,
  last_event_at               TEXT,
  last_event_type             TEXT
);
CREATE INDEX idx_sessions_workflow ON sessions(workflow_id, item_id);
CREATE INDEX idx_sessions_item ON sessions(item_id);
CREATE INDEX idx_sessions_parent ON sessions(parent_session_id);

-- ---------------------------------------------------------------------------
-- events — append-only state-machine + harness debug trace.
-- ---------------------------------------------------------------------------
CREATE TABLE events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ts          TEXT NOT NULL,
  workflow_id TEXT REFERENCES workflows(id) ON DELETE CASCADE,
  item_id     TEXT REFERENCES items(id) ON DELETE SET NULL,
  session_id  TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  stage       TEXT,
  phase       TEXT,
  attempt     INTEGER,
  event_type  TEXT NOT NULL,
  level       TEXT NOT NULL,
  message     TEXT NOT NULL,
  extra       TEXT
);
CREATE INDEX idx_events_workflow ON events(workflow_id, ts);
CREATE INDEX idx_events_session ON events(session_id, ts);
CREATE INDEX idx_events_type ON events(event_type);

-- ---------------------------------------------------------------------------
-- artifact_writes — provenance trail for every file written by a session.
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
-- pending_attention — authoritative source for the dashboard attention banner.
-- ---------------------------------------------------------------------------
CREATE TABLE pending_attention (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  workflow_id     TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  kind            TEXT NOT NULL,
  payload         TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  acknowledged_at TEXT
);
CREATE INDEX idx_pending_attention_workflow ON pending_attention(workflow_id);
CREATE INDEX idx_pending_attention_open ON pending_attention(workflow_id) WHERE acknowledged_at IS NULL;

-- ---------------------------------------------------------------------------
-- prepost_runs — per-command execution record.
-- ---------------------------------------------------------------------------
CREATE TABLE prepost_runs (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id   TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  workflow_id  TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  item_id      TEXT REFERENCES items(id) ON DELETE SET NULL,
  stage        TEXT NOT NULL,
  phase        TEXT NOT NULL,
  when_phase   TEXT NOT NULL CHECK (when_phase IN ('pre', 'post')),
  command_name TEXT NOT NULL,
  argv         TEXT NOT NULL,
  started_at   TEXT NOT NULL,
  ended_at     TEXT,
  exit_code    INTEGER,
  action_taken TEXT,
  stdout_path  TEXT,
  stderr_path  TEXT
);
CREATE INDEX idx_prepost_workflow ON prepost_runs(workflow_id, started_at);
CREATE INDEX idx_prepost_session ON prepost_runs(session_id);
