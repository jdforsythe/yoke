# Recipe — Creative writing (novel by chapter)

**Who it's for:** writers who want a long-form draft assistant that respects an
outline, drafts chapter by chapter, and runs an editorial pass between chapters
to keep continuity.

**The goal:** for each chapter in the outline, produce a draft, run an editorial
review against the chapter's beats and the running continuity ledger, loop back
on issues.

**Time:** depends on chapter length and how strict you set the reviewer. Plan for
overnight on a novella-length project.

---

## Project layout

```
novel/
├── .yoke/templates/novel.yml
├── docs/
│   ├── outline.json             # the chapter manifest (items)
│   ├── style-guide.md           # voice rules
│   ├── continuity.md            # running ledger; reviewer updates this
│   └── agents/
│       ├── drafter.md
│       └── editor.md
├── prompts/
│   ├── draft.md
│   └── edit.md
├── chapters/                    # output: one file per chapter
└── scripts/
    ├── append-handoff-entry.js
    └── check-edit-verdict.js
```

`docs/style-guide.md` and `docs/continuity.md` are your authored documents. The
editor phase appends to `docs/continuity.md` (named entities, plot facts, etc.)
across chapters so later chapters can read it as context.

---

## The template

`.yoke/templates/novel.yml`:

```yaml
version: "1"

template:
  name: novel-by-chapter
  description: "Draft and edit each chapter in order, with a running continuity ledger"

pipeline:
  stages:
    - id: chapters
      run: per-item
      items_from: docs/outline.json
      items_list: "$.chapters"
      items_id: "$.id"
      items_depends_on: "$.depends_on"
      items_display:
        title: "$.title"
        subtitle: "$.act"
        description: "$.synopsis"
      phases: [draft, edit]

phases:
  draft:
    command: claude
    args: ["-p", "--output-format", "stream-json", "--verbose",
           "--dangerously-skip-permissions",
           "--model", "claude-sonnet-4-6"]
    prompt_template: prompts/draft.md
    max_outer_retries: 2
    retry_ladder: [continue, fresh_with_failure_summary, awaiting_user]
    post:
      - name: chapter-file-present
        run: ["bash", "-c", "test -s chapters/$(node -e 'console.log(require(\"./output/last-id.json\").id)').md"]
        timeout_s: 10
        actions:
          "0": continue
          "*": { retry: { mode: fresh_with_failure_summary, max: 2 } }

  edit:
    command: claude
    args: ["-p", "--output-format", "stream-json", "--verbose",
           "--dangerously-skip-permissions",
           "--model", "claude-sonnet-4-6"]
    prompt_template: prompts/edit.md
    post:
      - name: check-edit-verdict
        run: ["node", "scripts/check-edit-verdict.js"]
        timeout_s: 10
        actions:
          "0": continue
          "1": { goto: draft, max_revisits: 3 }
          "*": stop-and-ask

worktrees:
  base_dir: .worktrees
  branch_prefix: novel/
  bootstrap:
    commands: []
```

> **Note:** The `chapter-file-present` gate above uses a small trick (the drafter
> writes a `output/last-id.json` so the gate knows which file to check). A
> simpler equivalent is to have the drafter write the chapter to a fixed path
> like `chapters/draft.md` and rotate it on success — fewer moving parts. Pick
> whichever you prefer; both are valid.

---

## The outline manifest

`docs/outline.json`:

```json
{
  "title": "The Long Way Home",
  "chapters": [
    {
      "id": "ch-01",
      "act": "Act I",
      "title": "The Departure",
      "synopsis": "Maya leaves her job; the inciting call from Lena lands.",
      "beats": [
        "Open in Maya's apartment, mid-morning",
        "Phone call from Lena reveals the family crisis",
        "Decision moment: stay or go"
      ],
      "depends_on": []
    },
    {
      "id": "ch-02",
      "act": "Act I",
      "title": "The Old House",
      "synopsis": "Maya arrives at the family house and finds it changed.",
      "beats": [
        "Arrival scene with sensory detail",
        "First conflict with Lena over inheritance",
        "Discovery of the locked study"
      ],
      "depends_on": ["ch-01"]
    },
    {
      "id": "ch-03",
      "act": "Act II",
      "title": "The Letters",
      "synopsis": "Maya finds her grandfather's letters and a lead.",
      "beats": [
        "Picking the lock to the study (callback to opening)",
        "Reading the letters; voiceover or italic interleaving",
        "Decision to follow the lead"
      ],
      "depends_on": ["ch-02"]
    }
  ]
}
```

The `depends_on` chain forces strict order — Yoke won't start ch-02 until ch-01
is complete, so the continuity ledger built during ch-01's edit phase is
available to ch-02's drafter.

---

## The prompts

### `prompts/draft.md`

```
You are the drafter. Read `docs/agents/drafter.md` before proceeding.

State in one sentence what you are about to draft, then proceed.

## Chapter spec
{{item}}

## Style guide
{{architecture_md}}

## Continuity ledger (facts established in earlier chapters)
(read `docs/continuity.md` from the worktree root)

## Editor feedback from prior attempts
{{handoff}}

## Recent commits
{{git_log_recent}}

---

Write the chapter to `chapters/{{item_id}}.md`. Hit every beat in the spec.
Length target: 2000–3500 words unless the spec says otherwise.

Honor the continuity ledger — never contradict an established fact. If a fact
needs to change, surface it explicitly in your handoff entry rather than
overwriting it silently.

When done, append a handoff entry via scripts/append-handoff-entry.js naming the
chapter id, word count, beats hit, and any decisions you made about ambiguous
spec items.

Stop after the file is written.
```

### `prompts/edit.md`

```
You are the editor. Read `docs/agents/editor.md` before proceeding.

State in one sentence what you are about to verify, then proceed.

## Chapter spec
{{item}}

## Style guide
{{architecture_md}}

## Continuity ledger
(read `docs/continuity.md`)

## Drafted chapter
(read `chapters/{{item_id}}.md`)

## Drafter's handoff
{{handoff}}

---

For each beat in the spec, confirm whether the chapter hits it. For each
sentence in the chapter, check style-guide compliance and continuity.

Write `review-verdict.json` at the worktree root:

  {"verdict":"PASS","notes":"<one paragraph for the author>"}

or

  {"verdict":"FAIL","blocking_issues":["beat 2 missing", "POV slip in para 12", ...]}

On PASS, append the new continuity facts established by this chapter to
`docs/continuity.md` (named characters, plot revelations, time/place anchors).
Use a dated section header.

Do not rewrite the chapter. Stop after the verdict and (on PASS) ledger update
are written.
```

---

## What you'll see in the dashboard

1. Three chapter cards on the **Feature board**, all `pending`. ch-01 starts
   immediately; ch-02 and ch-03 are `blocked`.
2. ch-01 drafts → edits. If edit FAILs, loop back to draft (up to 3 revisits per
   chapter).
3. ch-01 PASSes → ledger gets a new section → ch-02 unblocks and starts. Its
   draft prompt now reads the updated ledger.
4. Same for ch-03.
5. On completion, all three chapters live under `chapters/` in the workflow
   worktree. Merge the branch back to `main` to get them into your repo.

---

## Tweaks

- **Want a separate continuity-checker reviewer?** See
  [multi-reviewer](multi-reviewer.md) — adapt the angles to "beat-coverage,"
  "style-compliance," "continuity."
- **Want one massive draft instead of per-chapter?** Use `run: once` with a
  single `draft` phase and a single `edit` phase. You give up parallelism but
  reduce the harness overhead.
- **Want to manually approve each chapter?** Add `needs_approval: true` to a
  separate stage that wraps `edit`. Or use `stop-and-ask` in the verdict gate so
  every chapter waits for you in the dashboard.

---

## See also

- [Configuration reference](../configuration.md)
- [Prompts guide](../prompts.md)
- [Recipe — marketing-pipeline](marketing-pipeline.md) for a similar non-coding
  shape with parallel items.
