# Brainstorm

Replace this file with your own free-form brainstorm. The planner reads it
end-to-end and produces `docs/brainstorm-features.json` from it.

## What to put here

This is the loosest of the planner inputs — paragraphs, scratch notes, links,
constraints, half-formed ideas. Don't try to write a spec. The planner will
do the structuring.

## Suggested sections

- **Goal / vibe.** What you want to exist when this is done.
- **Constraints.** Stack, platforms, anything definitely off the table.
- **Surface area.** Subsystems, files, endpoints you expect to touch.
- **Inspirations.** Other projects, articles, prior art.
- **Open questions.** Unresolved decisions you'd like the planner to surface
  via `needs_more_planning: true` rather than silently guess.

## Example seed (delete me)

> A small CLI that takes a directory of markdown files and produces a static
> site with a sidebar of files and Pagefind search. Stack: Node 20, no build
> step beyond `npm i && node bin/site.js`. Should support a `serve` command
> that watches the directory and reloads on change. No theming knobs in v1
> beyond a single `--theme dark|light` flag.
