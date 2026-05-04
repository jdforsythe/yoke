# scripts/demo/

Repeatable demo-data pipeline used to regenerate the dashboard screenshots in
`docs/img/`. The fixture seeds a SQLite DB with one running workflow, two
archived workflows, and a realistic JSONL session transcript so the dashboard
renders a populated view without ever spawning a real Claude session.

## Layout

| File | Purpose |
| --- | --- |
| `templates/*.yml` | Five demo template files copied into `<configDir>/.yoke/templates/` |
| `fixture.ts` | Typed `DemoFixture` describing every workflow/item/session/log frame |
| `seed.ts` | `tsx` entry — copies templates, applies migrations, inserts the fixture |
| `capture.spec.ts` | Playwright spec that boots `bin/yoke` against the seeded dir and snaps PNGs |
| `playwright.config.ts` | Headless 1280x800 config for the spec |
| `.tmp/` | Generated configDir (gitignored) — DB lives at `.tmp/.yoke/yoke.db` |

## Common targets

```sh
make demo-seed     # populate scripts/demo/.tmp/.yoke/yoke.db
make demo-serve    # seed + run yoke at http://127.0.0.1:7793
make demo-shots    # seed + boot yoke + capture every PNG
make demo-clean    # rm -rf scripts/demo/.tmp
```

The serve target uses `--no-scheduler` so the seeded data stays static
(the running workflow keeps its frozen `paused_at`, no items advance).

## Extending the fixture

Edit `fixture.ts`:

- All timestamps are integer **offsets in seconds** from the seed-time `now`.
- IDs (workflow/item/session) are hardcoded UUIDs so screenshot URLs survive
  re-seeding.
- Add new `DemoLogFrame` entries to a session's `logFrames` array to grow the
  live transcript; the seeder rewrites their `ts` against a fresh baseline.

The seeder reuses production helpers (`openDbPool`, `applyMigrations`,
`makeSessionLogPath`) so any schema change in `src/server/storage/` is picked
up automatically — no copy-pasted SQL to keep in sync.
