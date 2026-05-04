# one-shot

The smallest yoke pipeline that still earns its keep. One stage, one phase,
one prompt, one artifact. The build engineer reads
`docs/idea/one-shot-brief.md`, builds the thing, runs the tests, and stops.
No planner, no reviewer, no per-item loop, no ceremony.

## Who it's for

You have a focused, one-session job: a CLI scraper, a polyfill, a Bash script,
a tiny library. You want Claude to take a brief and ship a working artifact
without you babysitting the YAML.

## When to pick it

- The whole job fits in one sentence.
- There is exactly one artifact at the end.
- You don't need a review pass — failing the test command is your safety net.

For multi-feature builds, pick `plan-build`. For high-stakes code, pick
`plan-build-review` or `multi-reviewer`.

## Knobs to tweak

- Edit `docs/idea/one-shot-brief.md` — that's the prompt's source of truth.
- Swap `pnpm test` in `yoke/templates/one-shot.yml` post-gate for your stack
  (`npm test`, `cargo test`, `pytest -x`, `go test ./...`).
- Update `docs/agents/build-engineer.md` if your project has house rules.

## To use

`yoke init --template one-shot`

(or copy these files into your project root if your `yoke` doesn't yet have
the `--template` flag).
