-- Migration 0003 — workflow archive support
-- Adds archived_at column to workflows for soft-delete filtering.
-- Forward-only: no data migration required (NULL = not archived for all
-- existing rows by default, matching the column default semantics).

ALTER TABLE workflows ADD COLUMN archived_at TEXT;

-- Partial index for the default list query (archived_at IS NULL).
-- Keeps the index small: only unarchived rows are indexed here.
CREATE INDEX idx_workflows_active ON workflows(created_at DESC) WHERE archived_at IS NULL;
