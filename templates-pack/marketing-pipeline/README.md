# marketing-pipeline

A non-coding pipeline for outbound copy. Seed `docs/idea/marketing-pipeline-personas.json`
with one entry per target persona; the copywriter generates 5 differentiated
ad variants per persona; the brand-voice reviewer reads them all and gates
PASS/FAIL. FAIL routes back to the copywriter with the offending lines
quoted.

## Who it's for

Marketers, indie hackers, and founders who want a campaign's worth of copy
generated in parallel — with brand voice enforced by a reviewer that won't
rubber-stamp same-idea-reworded variants or let invented testimonials slip
through.

## When to pick it

- You have 2–20 personas to write for.
- You want angle differentiation (value / pain / social-proof / curiosity /
  urgency) not just word-level paraphrases.
- Your brand guide has rules a reviewer can enforce.

For long-form (book, manual), pick `content-pipeline`. For code, pick a
plan-build template.

## Knobs to tweak

- Edit `docs/idea/marketing-pipeline-brief.md` (your brand guide — inherited
  by every prompt as `{{architecture_md}}`).
- Replace the seed personas in `docs/idea/marketing-pipeline-personas.json`.
- Tune the variant count and angle slate in `prompts/write.md` and
  `scripts/check-variants-nonempty.js`.
- Update copywriter / brand-voice-reviewer personas under `docs/agents/`.

## To use

`yoke init --template marketing-pipeline`

(or copy these files into your project root if your `yoke` doesn't yet have
the `--template` flag).
