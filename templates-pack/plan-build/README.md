# plan-build

Plan once, then build feature by feature in isolated worktrees. No reviewer
in the loop — your tests and your eyes are the safety net. The planner reads
`docs/idea/plan-build-brief.md` and emits `plan-build-features.json`; the
implementer takes one feature at a time and stops when the test gate is
green.

## Who it's for

Solo developers who trust their tests, are happy reading every diff in a PR
themselves, and want decomposition + parallel feature execution without the
overhead of an automated review pass.

## When to pick it

- The work splits cleanly into 5–15 independent features.
- You want `depends_on` ordering so feature C can wait on A and B.
- A red `pnpm test` is enough to catch regressions — you don't need an LLM
  reviewer to second-guess each commit.

For a review loop, pick `plan-build-review`. For brainstorm-seeded planning,
pick `brainstorm-plan-build-review`.

## Knobs to tweak

- Edit `docs/idea/plan-build-brief.md`.
- Swap `pnpm test` in `yoke/templates/plan-build.yml` for your stack.
- Update the planner / implementer personas under `docs/agents/`.

## To use

`yoke init --template plan-build`

(or copy these files into your project root if your `yoke` doesn't yet have
the `--template` flag).
