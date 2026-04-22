-- Migration 0006 — graph_state cache for the Graph view.
-- Nullable JSON blob holding a serialized WorkflowGraph. NULL means the graph
-- has not been materialized yet for this workflow; the subscribe handler
-- derives it on first read via deriveFromHistory() and persists the result.

ALTER TABLE workflows ADD COLUMN graph_state TEXT;
