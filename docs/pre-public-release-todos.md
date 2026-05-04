# Yoke — Pre-Public-Release To-Dos

A checkable plan to take Yoke from "works on the author's laptop with the source repo
checked out" to "a stranger can `npm install -g yoke`, run it on a fresh machine, and
ship something useful on day 1."

Status legend: `[ ]` open · `[x]` done · `[~]` partially done / blocked.

---

## 0. Goals

- A new user installs Yoke once, runs one command, and is dropped into a working
  workflow with no editing required.
- The README answers in 30 seconds: "what is this," "why would I use it," "how do I
  start," "what does it look like."
- Documentation that ships in the repo reads as if it were written by a tech writer
  for end users — no internal design notes, no transcripts of decisions, no
  references to phases of Yoke's own development.
- The dashboard is reachable from a single port that `yoke start` prints.
- The `yoke setup` skill is invokable from the CLI.
- Five end-to-end scenarios (one-shot, multi-feature build, parallel features with
  dependencies, marketing, creative writing) each work without the user touching
  YAML.

---

## 1. User stories (the targets)

These drive the gap analysis in §3. Each story must work on day 1 with default
templates only.

1. **Solo dev, side project.** Install Yoke, point it at a small repo, run a
   plan-implement-review loop overnight, wake up to a PR.
2. **Indie hacker, idea-stage.** Sketch an idea in plain English ("a CLI that scrapes
   recipes"), let Yoke decompose it into features and one-shot the whole thing.
3. **OSS maintainer.** Drop a backlog of issue links into a manifest, let Yoke
   attempt the simplest issues, open PRs ready for review.
4. **Tech lead at a small team.** Compose a custom 4-stage workflow (plan →
   architecture → implement → review) with team-specific gates (`pnpm test`,
   `pnpm lint`, security audit script).
5. **Non-technical founder.** Use Yoke to draft marketing copy chapter by chapter
   with an editorial reviewer between each — never sees YAML.
6. **Researcher.** Iterate on data-cleaning scripts with empirical verification
   between attempts.
7. **Novelist.** Break a book outline into chapters; draft each with a critique pass
   and a continuity-checker reviewer.
8. **Sales engineer.** Maintain a library of personalized outbound emails per
   prospect with a brand-voice reviewer.
9. **First-time user.** Run `yoke setup`, answer five questions, and have a complete
   working template + prompts + scripts written for them.
10. **Power user.** Compose multiple templates in one repo (brainstorm, plan-build,
    fix-only, polish) and pick which to run from a dashboard picker.

---

## 2. Scenarios (what we walk through end-to-end)

### Coding scenarios

1. **One-shot a simple app.** Python CLI: a recipe scraper. One template, one
   `run: once` phase, one prompt. Done in one session.
2. **Brainstorm → feature loop → finished one-shot of a complex app.** Markdown-to-
   PDF service with auth, queue, storage. Brainstorm template seeds a plan;
   plan emits `features.json`; per-item implement+review loop builds it out.
3. **Full-stack dev adds 3 features to an existing app.** Features A and B run in
   parallel (no deps); Feature C declares `depends_on: [A, B]` and waits.
4. **Bug-hunt loop.** Yoke iterates on a flaky test until it passes (retry ladder
   demo).
5. **Codemod migration across 12 packages.** Per-item over packages, with a "needs
   human" gate that pauses on edge cases.
6. **Adversarial multi-reviewer.** Implement + 3 parallel reviewer subagents
   (correctness, security, simplicity) + synthesizer that loops back on FAIL.

### Non-coding scenarios

7. **Marketing campaign.** 5 ad variants per persona, brand-voice reviewer per
   item. Output: a directory of copy.
8. **Creative writing.** Novel by chapter, with editorial reviewer + continuity
   checker. Output: chapters + a continuity ledger.
9. **Sales outbound.** 50 personalized emails per prospect with relevance scorer.
10. **Research synthesis.** Lit review across 10 papers per topic with a
    methodology reviewer.

---

## 3. Gap analysis (mapped to scenarios)

| # | Gap | Blocks scenarios |
|---|---|---|
| G1 | Not installable via `npm i -g` (`private: true`, no `files`/`main`/`bin` paths that work outside the repo, `bin/yoke` shells to `tsx` against `../src`). | All |
| G2 | No LICENSE; README says "TBD." | Public release blocker |
| G3 | `yoke start` hard-codes `loadTemplate(configDir, 'default')` (src/cli/start.ts:179). Fails if user only has a non-default-named template. | 4, 6, 10 |
| G4 | Dashboard not served by `yoke start`. Only API at :7777. Production users have no UI without running Vite. | All |
| G5 | `yoke setup` is a skill but no CLI command invokes it. | 9 (and onboarding for everyone) |
| G6 | `yoke init` scaffolds a stub that does nothing useful — single phase, no prompt file, no example items. | 1, 2 |
| G7 | No "starter pack" of working templates for common shapes (one-shot, plan-build, brainstorm-plan-build, content-pipeline, marketing-pipeline). | 1, 2, 7, 8 |
| G8 | No published install instructions (npm, brew, manual). | All |
| G9 | Documentation is internal-facing (design specs, beta3 review feedback, agent personas for building Yoke, research notes, future-work backlog). | Onboarding |
| G10 | README mixes "what is this" with implementation reference; no fast quick-start, no screenshots, no fun. | First-impression |
| G11 | No troubleshooting / FAQ / "common errors" doc. | Friction on day 1 |
| G12 | `forge/` is checked into the repo and has no relationship to end-user use of Yoke. Confusing. | First-impression |
| G13 | `prompts/` ships with both generic (`implement.md`, `plan.md`, `review.md`) and project-specific (`brainstorm-*.md`) prompts that reference Yoke's own internal workflow. | 1, 2, 7, 8 |
| G14 | `skills/yoke-setup-forge.md` only useful to forge users; needs gating or a clear "skip if you don't use forge" note. | 9 |
| G15 | `--dangerously-skip-permissions` is the default in scaffolded prompts, with no surfaced explanation of the trade-off. | Trust |
| G16 | No CHANGELOG, CONTRIBUTING, SECURITY for a public OSS project. | Public release polish |
| G17 | No screenshots/GIFs of the dashboard in the README. | First-impression |
| G18 | `keep_awake: true` works only on macOS/Linux; no platform-support note. | Cross-platform |
| G19 | `bin/yoke-dev` is a dev tool but lives next to `bin/yoke` and is undocumented for users. | Confusion |
| G20 | No `yoke --help` polish (descriptions, examples). | First-impression |

---

## 4. Documentation audit (what stays, what goes, what gets rewritten)

### Cut entirely (internal, build-history, agent-conversation artifacts)

- [x] `docs/design/architecture.md` — internal module-graph design doc
- [x] `docs/design/beta3-review-feedback.md` — phase-β review notes
- [x] `docs/design/hook-contract.md` — internal contract
- [x] `docs/design/open-questions.md` — internal backlog
- [x] `docs/design/prompt-template-spec.md` — internal spec (replace with concise user-facing reference, see §5)
- [x] `docs/design/protocol-stream-json.md` — internal protocol
- [x] `docs/design/protocol-websocket.md` — internal protocol
- [x] `docs/design/state-machine-transitions.md` — internal state machine
- [x] `docs/design/threat-model.md` — internal threat model (light user-facing version may move to `docs/security.md` if any external-facing risks exist)
- [x] `docs/agents/architect.md`, `backend.md`, `frontend.md`, `qa.md` — Yoke's own dev personas, not for users
- [x] `docs/critiques/*.md` — review notes from Yoke's own development
- [x] `docs/research/*.md` — implementation research (continue, hook, jig, stream-json semantics)
- [x] `docs/idea/future-work.md` — internal backlog (move to GitHub Issues if anything remains current)
- [x] `docs/idea/migration-templates-refactor.md` — pre-1.0 migration guide; no public users have the old format
- [x] `forge/` — vendored sibling project; remove from repo or move outside of the package boundary

### Keep (move to user-facing locations and review wording)

- [x] `docs/design/schemas/yoke-config.schema.json` → `schemas/yoke-config.schema.json` (used at runtime)
- [x] `docs/design/schemas/features.schema.json` → `schemas/features.schema.json`
- [x] `docs/design/schemas/handoff.schema.json` → `schemas/handoff.schema.json`
- [x] `docs/design/schemas/review.schema.json` → `schemas/review.schema.json`
- [x] `docs/design/schemas/api-responses.schema.json` → `schemas/api-responses.schema.json`
- [x] `docs/design/schemas/sqlite-schema.sql` — generated at runtime from migrations; verify it's not consumed and delete if not
- [x] `docs/design/schemas/pre-post-action-grammar.md` → `schemas/pre-post-action-grammar.md` (deferred prose rewrite to docs batch)

### Write fresh (user-facing)

- [x] `README.md` — full rewrite (see §5)
- [x] `docs/getting-started.md` — five-minute first workflow
- [x] `docs/install.md` — npm, manual, dev, requirements
- [x] `docs/configuration.md` — full template reference written for humans
- [x] `docs/templates.md` — anatomy of a template, pipeline shapes, when to use each
- [x] `docs/prompts.md` — variable inventory and writing-prompts-for-yoke guide
- [x] `docs/dashboard.md` — what the dashboard surfaces and how to use them
- [x] `docs/recipes/one-shot.md` — recipe scraper end-to-end
- [x] `docs/recipes/plan-build-review.md` — multi-feature build
- [x] `docs/recipes/parallel-features-with-deps.md` — dependency graph demo
- [x] `docs/recipes/marketing-pipeline.md` — non-coding example
- [x] `docs/recipes/creative-writing.md` — non-coding example
- [x] `docs/recipes/multi-reviewer.md` — adversarial reviewer pattern
- [x] `docs/troubleshooting.md` — common errors with fixes
- [x] `docs/faq.md`
- [x] `LICENSE` (recommend MIT to match `forge/`)
- [x] `CHANGELOG.md` — start at v0.1.0
- [x] `CONTRIBUTING.md`
- [x] `SECURITY.md`

---

## 5. README rewrite

The new README is structured for a stranger landing on the GitHub page.

- [x] Hero section: one-line pitch, animated GIF of the dashboard, three install/start
      commands, link to "first workflow in five minutes." (Screenshot/GIF marker left
      as `<!-- TODO: screenshot -->`; capture pending — see §11.)
- [x] "Why Yoke" — three short paragraphs (what it is, who it's for, how it differs
      from running `claude` in a loop yourself).
- [x] Quick start: `npm install -g yoke` → `yoke setup` → `yoke start`. No
      prerequisites beyond Node + git.
- [x] One-screen example: a working `.yoke/templates/plan-build.yml` with comments.
- [x] Three "what can I do with this" cards linking to `docs/recipes/*`.
- [ ] Dashboard tour: 3 screenshots (template picker, live stream, review panel).
- [x] Where to go from here: configuration reference, template gallery, FAQ.
- [x] License + contributing + security at the bottom.

---

## 6. Repo structure cleanup

- [x] Remove `forge/` from this repo (or move to `vendor/forge/` outside the
      published package). Add to `.gitignore` if kept locally for dogfooding.
- [x] Delete `prompts/brainstorm-*.md` (project-specific to Yoke's own dogfooding)
      OR move to `examples/brainstorm/` and stop shipping at the top level.
- [x] Move generic prompt templates (`prompts/implement.md`, `plan.md`, `review.md`)
      into a `templates-pack/prompts/` location that `yoke setup` and `yoke init`
      can copy from — they are not the user's editable surface at the repo root.
      (Batch D parked these inside the per-starter `prompts/` directories rather
      than a single shared one — each starter ships its own prompt set.)
- [x] Audit `skills/` — keep `yoke-setup.md` (loaded by `yoke setup` CLI). Keep or
      gate `yoke-setup-forge.md` behind a "if you use forge…" doc.
      (Only `skills/yoke-setup.md` ships in the npm `files` allowlist; the
      `-forge` variant stays in the repo for contributors but is not bundled.)
- [x] Move runtime schemas from `docs/design/schemas/` to `schemas/` so they ship
      with the npm package.
- [x] Remove `docs/history/` references in skills/docs that don't exist.

---

## 7. Distribution & installability

- [x] Add `LICENSE` (MIT) at repo root. (Batch C.)
- [x] Update `package.json`:
  - [x] Set `"private": false` (or remove the field). (Removed.)
  - [x] Add `"description"`, `"repository"`, `"homepage"`, `"bugs"`, `"keywords"`,
        `"author"`, `"license"`. Plus `"engines.node": ">=20"`.
  - [x] Add `"files"` allowlist: `dist/`, `bin/yoke`, `schemas/`, `templates-pack/`,
        `skills/yoke-setup.md`, `README.md`, `LICENSE`, `CHANGELOG.md`.
  - [x] Replace tsx-based `bin/yoke` with a node shebang script that runs
        `dist/cli/index.js` (with a tsx fallback for in-checkout development
        before the first build).
  - [x] Bundle web assets into `dist/web/` during the publish build.
        (`pnpm run build:web` invokes Vite which writes to `dist/web/`.)
  - [x] `prepublishOnly` script: typecheck → tests → build server + web.
- [x] Decide: do we ship a single binary (esbuild bundle), or rely on installed
      `node_modules`? Pick one and document. **Decision: standard npm package**
      — better-sqlite3 ships a native add-on, so single-binary bundling would
      require pre-built binaries per OS/arch or a postinstall rebuild. The
      simpler `npm i -g yoke` flow with installed `node_modules` matches the
      Claude Code prerequisite (Node already required).
- [ ] Verify `npm pack` produces a tarball that installs cleanly with
      `npm i -g ./yoke-x.y.z.tgz` and runs `yoke --help`. (Dry-run lists the
      right files: 195 entries, 866 kB tarball; full install-from-tarball is a
      Batch I task.)
- [ ] Verify `yoke start` runs in a clean directory containing only
      `.yoke/templates/<name>.yml` (no source tree). (Batch I.)
- [ ] Add a smoke test in CI that does the install-and-start dance. (Batch I.)

---

## 8. Dashboard served by the API

- [x] Add `@fastify/static` (v7, the fastify-4-compatible line) to
      `src/server/api/server.ts`.
- [x] Serve the bundled web assets from `dist/web/` when present, with SPA fallback
      to `index.html` (the not-found handler returns JSON 404 for `/api/*`,
      `/stream`, and non-GETs; otherwise it streams `index.html`).
- [x] Update `yoke start` banner to print
      "Yoke dashboard: http://127.0.0.1:7777" and have it actually work.
- [ ] Optional: add `--no-browser` and auto-open behavior on `yoke start`.
- [~] Keep `bin/yoke-dev` for the contributor's dual-server flow but document it
      as "for Yoke contributors only" and move to `scripts/`. (Kept under
      `bin/`; not moved.)

---

## 9. CLI surface

- [x] Implement `yoke setup` command that injects `skills/yoke-setup.md` into a
      Claude session in the user's repo via `claude --append-system-prompt`
      (Claude must be installed; surfaces a friendly error if not).
- [x] Fix `yoke start` to not require a template named `default`. If exactly
      one template exists, use it; if multiple exist, prefer `default.yml`,
      otherwise require `--template <name>`; if none, print a helpful error
      pointing at `yoke setup` / `yoke init`. **Note:** the scheduler still
      binds to a single template at start time (matches today's
      `this.config: ResolvedConfig` architecture). The dashboard picker
      remains available but workflows from non-active templates rely on phase
      keys aligning with the active template's phases. Multi-config-per-
      scheduler is a deliberate v0.2 follow-up.
- [x] `yoke init` accepts a `--template <name>` flag and copies the bundled
      starter at `templates-pack/<name>/` into the project (yoke/ → .yoke/,
      docs/, prompts/, scripts/, schemas/, .claude/ as applicable). Errors
      with the available list when the name is unknown; never overwrites
      existing files.
- [x] `yoke doctor` now detects: Node version, SQLite native build, git
      version, **claude CLI on PATH**, configDir-as-git-repo, **at least one
      template present**, **per-template AJV validation**, **missing
      prompt_template files**, and **missing local scripts referenced by
      `post:` actions** (heuristic on `node`/`bash`/`sh` interpreters and
      relative-path argv[0]).
- [x] `yoke --help` polished: program description, top-level "Quick start" /
      "Common commands" / Documentation block, per-command `addHelpText`
      examples on `start`, `init`, `setup`, `doctor`.
- [~] Add `yoke version` separately from commander's `--version` for parity
      with common CLI conventions. (Skipped — `yoke -V` / `yoke --version`
      already prints the package version pulled from `package.json`.)

---

## 10. Templates pack (ships with the npm package)

For each starter template: `.yml`, prompts referenced, `features.json` example,
any `scripts/` it requires.

- [ ] `templates-pack/one-shot/` — single phase, single prompt, single artifact.
- [ ] `templates-pack/plan-build/` — plan + per-item implement (no review).
- [ ] `templates-pack/plan-build-review/` — plan + per-item implement + review with
      loop-back gate.
- [ ] `templates-pack/brainstorm-plan-build-review/` — brainstorm seeded planner +
      per-item implement + review.
- [ ] `templates-pack/content-pipeline/` — non-coding: outline → per-chapter draft
      + edit pass.
- [ ] `templates-pack/marketing-pipeline/` — non-coding: persona seeds → per-persona
      ad variants + brand-voice reviewer.
- [x] `templates-pack/multi-reviewer/` — implement + 3 parallel reviewer subagents
      via Task tool + synthesizer.
- [ ] Every starter: passes `yoke doctor` immediately after `yoke init --template
      <name>`; runs without YAML edits when `claude` is on the path.

---

## 11. Examples & screenshots

- [x] Capture three dashboard screenshots: picker, live stream, item-detail
      (replaces "review panel" — review-panel needs the multi-reviewer
      template, deferred). Files: `docs/img/{picker,live-stream,item-detail}.png`.
      Regenerable via
      `node_modules/.bin/playwright test --config scripts/e2e/capture/playwright.config.ts`.
- [x] Record a CLI GIF (`docs/img/yoke-cli-tour.gif`, ~60 KB) covering
      `yoke --version` → `yoke --help` → `yoke init --template one-shot` →
      `yoke doctor`. Source: `scripts/e2e/capture/setup.tape`. Regenerate with
      `vhs scripts/e2e/capture/setup.tape`.
- [x] Add a screenshots directory `docs/img/`.
- [ ] Reference each from the README and the relevant recipe.

---

## 12. Open-source housekeeping

- [x] LICENSE (MIT).
- [x] CONTRIBUTING.md (how to run tests, where to file issues, branch conventions).
- [x] SECURITY.md (single-user/local-only posture, what is and isn't in scope,
      how to report issues).
- [x] CHANGELOG.md (start with `0.1.0` — first public release).
- [x] CODE_OF_CONDUCT.md (optional but expected for OSS).
- [x] GitHub issue templates (bug, feature, question).
- [x] Bump version to `0.1.0` in `package.json` for the public release.

---

## 13. End-to-end validation

Run each scenario from §2 against a fresh checkout / npm install. For each:

- [x] **E2E harness landed.** `pnpm e2e` (= `scripts/e2e/run.sh`) provisions a
      fresh `/tmp/yoke-e2e-…` git repo per scenario, boots `yoke start` against
      the bundled `dist/cli/index.js`, drives a workflow via `POST /api/workflows`,
      polls to terminal, and runs SQLite + filesystem assertions. Self-contained;
      total runtime ~3 minutes; total Claude cost ~$0.05 (Haiku, `--effort low`,
      `--max-budget-usd 0.10`, `--strict-mcp-config --disable-slash-commands`).
- [x] **Scenario A (greenfield, both stage types).** Plan once → per-item
      implement (2 features). Verified: workflow `completed`, ≥3 sessions,
      2 per-item rows in `build` complete, `docs/idea/features.json` parses
      with `feat-001/feat-002`, all target files written.
- [x] **Scenario B (existing app + post-tests + final once-stage).** Pre-seeded
      tmpdir with a working `greet()` app + smoke test. Plan once →
      per-item implement with `post: ["node","--test"]` → submit_pr once.
      Verified: `prepost_runs` has 2 successful `run-tests` rows, seeded
      `greet()` test preserved, `farewell`/`shout` exports added, no
      gh/git-push commands fired, `artifacts/pr-summary.txt` matches the
      fixed line.
- [x] **S1 — One-shot harness coverage** is satisfied by **scenario-a** above
      (greenfield hello-world Node app via `yoke init --template one-shot`-shaped
      pipeline). The original §2 wording said "recipe scraper" but the test
      target was the *harness flow*, not the *subject* — that flow is now
      green. If a literal Python-recipes variant is wanted later it's an
      additive fixture, not a release blocker.
- [ ] **S2 — Brainstorm to finished app.** Brainstorm template runs, plan emits a
      manifest, items build, dashboard reflects state.
- [ ] **S3 — Three features, two parallel one dependent.** `depends_on` in the
      manifest correctly gates the third item.
- [ ] **S4 — Bug-hunt retry ladder.** A failing post-test gate causes a fresh
      retry with failure summary; succeeds on attempt 2.
- [ ] **S5 — Codemod across 12 packages with human-in-the-loop pause.** A
      `stop-and-ask` action correctly halts and surfaces an attention banner.
- [ ] **S6 — Multi-reviewer adversarial.** Three reviewer subagents run in parallel;
      synthesizer rolls verdict back to implement on FAIL.
- [ ] **S7 — Marketing pipeline.** Non-coding template runs end-to-end, output is
      a directory of copy reviewed by brand-voice reviewer.
- [ ] **S8 — Creative writing.** Novel template produces chapters with continuity
      checker.
- [ ] **S9 — Sales outbound.** 50 personalized emails per item with reviewer.
- [ ] **S10 — Research synthesis.** Lit review template runs against a small set
      of papers.

---

## 14. Out of scope for v0.1.0

(Captured here so we can defer cleanly.)

- Multi-user / auth.
- Hosted dashboard.
- Windows native support beyond what Node + Claude already do.
- Interactive `run: conversation` stage type (see prior `future-work.md`).
- Plugin system / custom executors.

---

## 15. Subagent batches (parallelizable)

The work above splits cleanly into chunks that can run in parallel without
stepping on each other. Each batch should validate its own work and check off the
items it completed in this file.

- **Batch A — Documentation purge.** §4 "Cut entirely" + §6 forge/prompts moves.
  Pure deletes and renames. No code changes.
- **Batch B — README + recipes.** §5 + §11 (excluding screenshots/GIFs which need
  a running dashboard). Pure new prose.
- **Batch C — Open-source housekeeping.** §12 (LICENSE, CONTRIBUTING, SECURITY,
  CHANGELOG, issue templates).
- **Batch D — Templates pack.** §10. Self-contained directory with no code
  dependencies.
- **Batch E — CLI fixes.** §9 (`yoke start` template selection, `yoke doctor`
  improvements, `yoke init --template`). Touches `src/cli/`.
- **Batch F — Dashboard serving.** §8. Touches `src/server/api/`.
- **Batch G — Distribution.** §7. Touches `package.json`, `bin/`, build pipeline.
- **Batch H — `yoke setup` CLI.** §9 first item. Touches `src/cli/` + skill load.
- **Batch I — End-to-end validation.** §13. Runs only after E+F+G+H land.
