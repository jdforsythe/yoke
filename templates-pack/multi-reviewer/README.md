# multi-reviewer

Implement + 3 parallel reviewer subagents + synthesizer with FAIL → loop back.

The `review` phase fans out to three independent Claude Code subagents —
**correctness**, **security**, and **simplicity** — via the Task tool. Each
writes a verdict file; a post-command synthesizer computes overall PASS/FAIL.
Any single FAIL routes the feature back to the implementer (up to three revisits).

## Who it's for

Teams shipping code where one reviewer is not enough — authentication systems,
data pipelines, public APIs, payment flows, anything where a correctness mistake
and a security blind spot could coexist without a single reviewer catching both.

## When to pick it

- The work splits into 5–15 independent features.
- You want independent correctness, security, and simplicity checks on each one.
- The extra review cost (~3× reviewer tokens per feature) is worth the angle coverage.

## How the review phase works

```
implement
   │
   └─► review-lead (review.md prompt)
           │
           ├──Task──► correctness reviewer → reviews/<id>/correctness.json
           ├──Task──► security reviewer    → reviews/<id>/security.json
           └──Task──► simplicity reviewer  → reviews/<id>/simplicity.json
                                                │
                                         synthesize-verdict.js
                                                │
                                       review-verdict.json (PASS/FAIL)
                                                │
                                    FAIL ────── goto implement (max 3)
```

The review-lead launches all three Task calls simultaneously and waits. The
post-command `synthesize-verdict.js` reads the three files and determines the
overall verdict. The review-lead never writes `review-verdict.json` itself.

## Trade-offs vs plan-build-review

| | plan-build-review | multi-reviewer |
|---|---|---|
| Reviewer agents | 1 | 3 (parallel) |
| Review token cost | 1× | ~3× |
| Angle coverage | General | Correctness + Security + Simplicity |
| Loop-back trigger | Any FAIL | Any single angle FAIL |

## Knobs to tweak

- Edit `docs/idea/multi-reviewer-brief.md` with your project description.
- Swap `pnpm test` in `yoke/templates/multi-reviewer.yml` for your stack's test command.
- Add reviewer angles by adding `.claude/agents/<angle>.md` files and updating
  the `ANGLES` array in `scripts/synthesize-verdict.js`.
- Tune `max_revisits` on the post-gate if three retries is too many or too few.
- Update reviewer personas in `.claude/agents/` to match your domain (e.g. swap
  simplicity for performance on a latency-sensitive service).

## To use

```
yoke init --template multi-reviewer
```

(or copy these files into your project root if your `yoke` doesn't yet have
the `--template` flag).
