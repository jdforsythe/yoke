# Glossary

A short reference for the words Yoke uses in templates, the dashboard, and
documentation. Skim once and the rest of the docs will read faster.

## Template-level

**Template.** A single YAML file at `.yoke/templates/<name>.yml` that describes
the entire workflow: which stages run, which prompts get used, which gates have
to pass, what artifacts are produced. Templates are the user-authored surface;
everything else Yoke does flows from them.

**Stage.** A top-level group of work in the template. A stage runs **once** per
workflow (e.g., a single planning step) or **per item** (e.g., one implement
step per feature in a manifest). Stages are listed under `pipeline.stages`.

**Phase.** The unit of agent work inside a stage. Each phase corresponds to one
prompt, one Claude invocation, and one session in the dashboard. A `plan` stage
might have a single `plan` phase; a `build` stage often has `implement` and
`review` phases that loop.

**Item.** A single thing being worked on inside a `per-item` stage. Items come
from a manifest (e.g., `features.json`) and can declare `depends_on` to gate on
other items. An item flows through every phase of the stage.

**Manifest.** The JSON file (typically `features.json`) that lists the items a
`per-item` stage will iterate over. Earlier stages can write the manifest;
later stages consume it.

## Run-time

**Workflow.** One execution of a template, end to end. Workflows have a stable
ID, a `created_at` timestamp, and live state in `.yoke/yoke.db`. The workflow
list is the left rail of the dashboard.

**Session.** One spawned `claude` process (or other agent CLI) that runs a
single phase for a single item. Sessions emit stream-json events that Yoke
captures, classifies, and renders live.

**Worktree.** A throw-away git checkout under `.worktrees/<workflow>/` where the
agent does its writes. Yoke creates one per workflow so your main checkout is
never modified, and removes it when the workflow completes.

**Attempt.** One try at a phase for a single item. If a phase fails (a gate
returns non-zero, the agent crashes), Yoke retries up to the per-phase retry
budget; each retry is a new attempt with a fresh session.

## Gates and recovery

**Gate.** A `pre` or `post` action that must succeed for a phase to advance.
Common gates: `pnpm test`, `pnpm lint`, a custom shell script, an artifact
schema check. Gate failures drive the retry ladder.

**Retry ladder.** Yoke's escalation policy when a phase fails: the next attempt
gets a "what failed last time" summary appended to its prompt; after the
configured retry budget is exhausted, the workflow transitions to
`awaiting_user` so a human can decide what to do next.

**Attention.** A surfaced reason the workflow needs a human — bootstrap failure,
retry exhaustion, an explicit `stop-and-ask` action. Attentions show up as a
banner in the dashboard and are dismissed with **Resume** or **Retry**.

**Hook contract.** The schema your agent writes to declare what it produced
this phase. Yoke validates the contract before advancing; a malformed or
missing contract sends the workflow to attention. Most users never look at the
contract directly — the bundled prompts already produce one.

## Artifacts

**Artifact.** A file the agent emits that subsequent phases (or you) consume.
Examples: `features.json` from a planner, `pr-summary.txt` for a PR, a generated
`README.md`. Artifacts are validated against a JSON Schema when one is
declared.

**Pre / post action.** A shell command Yoke runs before or after a phase. Most
commonly used to run tests (`post: ["pnpm", "test"]`) or seed input
(`pre: ["scripts/fetch-issue.sh"]`). The full grammar is in
[`schemas/pre-post-action-grammar.md`](../schemas/pre-post-action-grammar.md).
