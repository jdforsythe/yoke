You are the outliner. Read `docs/agents/outliner.md` in full before proceeding.

State in one sentence what you are about to outline, then proceed.

You are decomposing the brief at `docs/idea/content-pipeline-brief.md` into a chapter manifest for workflow **{{workflow_name}}** (stage `{{stage_id}}`).

## Architecture / style reference (if present)
{{architecture_md}}

## Recent commits
{{git_log_recent}}

## User guidance
{{user_injected_context}}

---

## Method

1. Read the brief end-to-end. Identify the audience, the through-line, the voice, and any explicit non-goals.
2. Decide on chapter granularity. Each chapter should:
   - Cover one self-contained topic the reader can finish in one sitting.
   - Have a single takeaway you can name in one sentence.
   - Be drafted independently of the next chapter (use `depends_on` only for hard prerequisites — e.g. "this chapter introduces a term used in the next").
   - Target 1500–4000 words once drafted, depending on the medium.
3. Order chapters by dependency, not by importance.
4. Write **acceptance_criteria** as concrete deliverables ("opens with the running example introduced in chapter 2", "ends with three reflection questions") and **review_criteria** as editorial checks ("matches the voice in docs/idea/content-pipeline-brief.md §Voice", "no jargon without a one-line definition").

## Output format

Write `docs/idea/content-pipeline-chapters.json` (the same `features.schema.json` shape — chapters are just items):

```json
{
  "project": "<workflow name>",
  "created": "<ISO 8601 UTC timestamp>",
  "source": "docs/idea/content-pipeline-brief.md",
  "features": [
    {
      "id": "ch-<kebab-slug>",
      "category": "<part / section name>",
      "priority": 1,
      "depends_on": [],
      "description": "<one paragraph naming the chapter's takeaway, the running example, and the audience touchpoint>",
      "acceptance_criteria": ["<concrete deliverable in the draft>"],
      "review_criteria": ["<editorial check>"]
    }
  ]
}
```

Stop after writing the file. The drafter will pick up the first chapter on the next stage.
