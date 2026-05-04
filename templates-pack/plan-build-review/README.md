# plan-build-review

The recommended default for any code you wouldn't merge unread. Plan once,
then per feature: implement, review, loop back to implement on FAIL (up to
three revisits). The reviewer is a verdict-only role — it reads the diff,
checks every AC and RC, and writes `review-verdict.json`. PASS advances;
FAIL bounces with a list of blocking issues for the implementer to address.

## Who it's for

Solo developers and small teams who want an automated second set of eyes on
each feature before it's considered done. The review pass adds wall-clock
time but catches missed AC, untested edge cases, and quietly-deferred
requirements.

## When to pick it

- The work splits into 5–15 independent features.
- "Did the implementer actually do what was asked?" is a question worth
  asking on each one.
- One reviewer is enough — for high-stakes code with multiple concerns
  (correctness + security + simplicity), pick `multi-reviewer` instead.

## Knobs to tweak

- Edit `docs/idea/plan-build-review-brief.md`.
- Swap `pnpm test` in `yoke/templates/plan-build-review.yml` for your stack.
- Tune `max_revisits` on the review post-gate if 3 retries feels wrong.
- Update the planner / implementer / reviewer personas under `docs/agents/`.

## To use

`yoke init --template plan-build-review`

(or copy these files into your project root if your `yoke` doesn't yet have
the `--template` flag).
