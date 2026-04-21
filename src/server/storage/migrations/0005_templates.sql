-- Migration 0005 — template support columns on workflows
-- Adds paused_at and template_name. Both are nullable so this forward-only
-- migration applies cleanly to existing rows (they receive NULL for both).
--
-- paused_at: set on explicit user pause or at server startup for non-terminal
--   workflows (templates refactor startup-pause behavior in t-06). NULL means
--   the workflow is runnable; non-NULL means it is paused.
--
-- template_name: denormalized pointer to the source template file name.
--   Informational only; the authoritative pipeline definition remains the
--   pipeline JSON snapshot on the same row.

ALTER TABLE workflows ADD COLUMN paused_at TEXT;
ALTER TABLE workflows ADD COLUMN template_name TEXT;

-- Index for the scheduler's hot-path tick query:
--   SELECT * FROM workflows
--   WHERE paused_at IS NULL AND status NOT IN ('completed', 'abandoned', 'completed_with_blocked')
-- A B-tree index on paused_at lets SQLite quickly isolate the NULL (runnable)
-- partition before applying the status filter.
CREATE INDEX idx_workflows_paused_at ON workflows(paused_at);
