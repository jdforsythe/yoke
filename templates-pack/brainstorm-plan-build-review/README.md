# brainstorm-plan-build-review

Mirrors the in-repo `brainstorm.yml` template — the same shape Yoke uses on
itself. You write a free-form `docs/brainstorm.md` (paragraphs, scratch notes,
half-baked ideas), the planner decomposes it into `docs/brainstorm-features.json`,
and each feature flows through implement + review with FAIL → loop back.

## Who it's for

Idea-stage developers who want to skip the spec-writing dance. The brainstorm
file is meant to be loose; the planner does the structuring. If the
brainstorm is too vague, the planner sets `needs_more_planning: true` and
asks concrete questions instead of guessing.

## When to pick it

- You have a goal but not a feature list.
- You want a planner pass to surface decisions before any code is written.
- The implement + review loop earns its keep on each feature.

For a tight, already-decomposed brief, pick `plan-build-review`. For a single
artifact with no decomposition, pick `one-shot`.

## Knobs to tweak

- Edit `docs/brainstorm.md`.
- Swap `pnpm test` in `yoke/templates/brainstorm-plan-build-review.yml` for
  your stack.
- Update the planner / implementer / reviewer personas under `docs/agents/`.

## To use

`yoke init --template brainstorm-plan-build-review`

(or copy these files into your project root if your `yoke` doesn't yet have
the `--template` flag).
