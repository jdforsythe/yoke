-- Migration 0002 — GitHub state columns on workflows
-- Adds six columns that track the auto-PR lifecycle for a workflow.
-- GithubStatus: disabled | unconfigured | idle | creating | created | failed
-- All columns nullable; existing rows get NULL (treated as 'disabled' by callers).

ALTER TABLE workflows ADD COLUMN github_state           TEXT;
ALTER TABLE workflows ADD COLUMN github_pr_number       INTEGER;
ALTER TABLE workflows ADD COLUMN github_pr_url          TEXT;
ALTER TABLE workflows ADD COLUMN github_pr_state        TEXT;
ALTER TABLE workflows ADD COLUMN github_error           TEXT;
ALTER TABLE workflows ADD COLUMN github_last_checked_at TEXT;
