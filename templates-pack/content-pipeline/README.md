# content-pipeline

A non-coding pipeline for long-form writing — book, course, manual, multi-part
essay. The outliner reads `docs/idea/content-pipeline-brief.md` and emits a
chapter manifest; each chapter flows through draft + edit with FAIL → loop
back to drafter. The "tests" gate asserts the chapter file exists and is
non-empty (no `pnpm test` here — chapters aren't code).

## Who it's for

Writers, course authors, and documentation owners who want Claude to draft
chapter-by-chapter with an editorial pass between each. The editor catches
voice drift, missed AC, and rubber-stamp prose; the drafter only loops back
on real blocking issues.

## When to pick it

- Long-form output (~5–25 chapters) where each is independently reviewable.
- You want voice / audience / through-line consistency enforced by an editor.
- A binary "file exists and is non-empty" gate is enough — your own read
  later is the polish pass.

For a single artifact, pick `one-shot`. For code, pick `plan-build-review`.

## Knobs to tweak

- Edit `docs/idea/content-pipeline-brief.md`.
- Replace the seed chapters in `docs/idea/content-pipeline-chapters.json` (or
  let the outliner regenerate it).
- Update the outliner / drafter / editor personas under `docs/agents/`.

## To use

`yoke init --template content-pipeline`

(or copy these files into your project root if your `yoke` doesn't yet have
the `--template` flag).
