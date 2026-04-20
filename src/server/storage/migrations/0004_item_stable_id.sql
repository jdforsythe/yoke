-- Migration 0004 — stable_id for per-item seeded rows
-- Adds stable_id TEXT column to items. NULL for once-stage items and
-- per-item stage placeholder rows (before seeding). Set by per-item-seeder.ts
-- when inserting real item rows. Existing rows remain NULL (forward-only).

ALTER TABLE items ADD COLUMN stable_id TEXT;

-- Partial index for stable_id lookups — only indexes post-seeded rows.
CREATE INDEX idx_items_stable_id ON items(stable_id) WHERE stable_id IS NOT NULL;
