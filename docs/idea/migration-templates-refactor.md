# Migration: .yoke.yml → .yoke/templates/

This note describes how an existing user migrates from the pre-templates-refactor
layout (a single `.yoke.yml` at the repo root) to the new template-directory layout
(one or more `*.yml` files under `.yoke/templates/`).

---

## Why the change

Before the templates refactor (t-02/t-03), `yoke start` loaded a single
`.yoke.yml` from the repo root. Every time you ran `yoke start`, it created a
new workflow instance from that one file.

After the refactor:

- Templates live under `.yoke/templates/` as named files (`default.yml`,
  `build-only.yml`, etc.).
- `yoke start` discovers all templates and serves a UI picker so you can choose
  which template to use and what to name the workflow instance.
- Multiple templates can coexist; one template can produce many named workflow
  instances.

---

## Step-by-step migration

### 1. Rename the `project:` key to `template:`

Open `.yoke.yml` and change the top-level block:

```yaml
# Before
project:
  name: my-project

# After
template:
  name: my-project
  description: "Optional human-readable description for the UI picker"
```

The `description` field is optional but improves the picker UI.

### 2. Move the file to `.yoke/templates/`

Create the templates directory and move the file:

```sh
mkdir -p .yoke/templates
mv .yoke.yml .yoke/templates/default.yml
```

You can use any filename (without spaces) — the filename becomes the template's
key in the picker. `default.yml` is the conventional starting point.

### 3. Verify the file is valid

```sh
yoke doctor
```

`doctor` will report any AJV validation errors. Common issues after migration:

- The old `project:` key now produces `unknown property "project"` — make sure
  you renamed it to `template:` in step 1.
- If `prompt_template` paths are relative, they resolve from the repo root
  (same as before). No changes needed.

### 4. Start the server

```sh
yoke start
```

Open the dashboard URL. You will see the template picker with your migrated
template listed. Click it, give your workflow a name, and click Run.

---

## Example: before and after

**Before (`.yoke.yml`):**

```yaml
version: "1"

project:
  name: my-project

pipeline:
  stages:
    - id: implement
      run: per-item
      items_from: docs/features.json
      items_list: "$.features"
      items_id: "$.id"
      phases:
        - implement

phases:
  implement:
    command: claude
    args:
      - "--output-format"
      - "stream-json"
      - "--verbose"
    prompt_template: .yoke/prompts/implement.md
```

**After (`.yoke/templates/default.yml`):**

```yaml
version: "1"

template:
  name: my-project
  description: "Per-item implement pipeline"

pipeline:
  stages:
    - id: implement
      run: per-item
      items_from: docs/features.json
      items_list: "$.features"
      items_id: "$.id"
      phases:
        - implement

phases:
  implement:
    command: claude
    args:
      - "--output-format"
      - "stream-json"
      - "--verbose"
    prompt_template: .yoke/prompts/implement.md
```

The only change is:
1. File moved from `.yoke.yml` → `.yoke/templates/default.yml`.
2. `project:` → `template:` (with optional `description` added).

---

## What happens to existing workflow instances?

Existing workflow rows in `yoke.db` are not affected. They have a `template_name`
column (populated from `config.template.name` at creation time) that is
informational only — it does not drive resumption or dedup. You can still view
and manage existing workflows in the dashboard after migrating.

---

## Multiple templates

You can add more templates at any time:

```sh
cp .yoke/templates/default.yml .yoke/templates/review-only.yml
# Edit review-only.yml to change template.name and the pipeline
```

All `*.yml` files in `.yoke/templates/` are listed in the UI picker
automatically on the next `yoke start`.
