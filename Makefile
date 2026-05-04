DB := .yoke/yoke.db

# last-status [PHASE=implement|review] [FEATURE=<id>]
# Prints PASS/FAIL verdict for the most recent matching session.
# Defaults to the most recent log of any phase/feature.
last-status:
	@log=$$(FEATURE=$(FEATURE) PHASE=$(PHASE) node scripts/get-log.js) && \
	echo "Log: $$log" && \
	node scripts/last-status.js "$$log"

# last-output [PHASE=implement|review] [FEATURE=<id>]
# Prints the full result text from the most recent matching session.
last-output:
	@log=$$(FEATURE=$(FEATURE) PHASE=$(PHASE) node scripts/get-log.js) && \
	echo "Log: $$log" && echo "" && \
	node scripts/last-output.js "$$log"

# last-logs — list all session logs newest first (queries SQLite)
last-logs:
	@node scripts/list-logs.js

# tail-session — pretty-print the most recent session log (static snapshot)
# Use FEATURE=<id> and/or PHASE=implement|review to filter.
tail-session:
	@log=$$(FEATURE=$(FEATURE) PHASE=$(PHASE) node scripts/get-log.js) && \
	node scripts/tail-session.js "$$log"

# tail-session-raw — follow live output from the most recent session log
tail-session-raw:
	@log=$$(FEATURE=$(FEATURE) PHASE=$(PHASE) node scripts/get-log.js) && \
	echo "Tailing: $$log" && \
	tail -f "$$log"

.PHONY: last-status last-output last-logs tail-session tail-session-raw

# ---------------------------------------------------------------------------
# Demo pipeline — repeatable seeded dashboard for README screenshots.
# All artifacts live under scripts/demo/.tmp (gitignored).
# ---------------------------------------------------------------------------

DEMO_DIR := $(CURDIR)/scripts/demo/.tmp
TSX      := $(CURDIR)/node_modules/.bin/tsx

demo-seed:                          ## Populate $(DEMO_DIR)/yoke.db from scripts/demo/fixture.ts
	@mkdir -p $(DEMO_DIR)
	@$(TSX) scripts/demo/seed.ts --config-dir $(DEMO_DIR)

demo-build:                         ## Build server + web (required so capture sees current GraphPane.tsx etc.)
	@pnpm run build

demo-serve: demo-build demo-seed    ## Start yoke against the seeded DB on :7793
	@bin/yoke start --config-dir $(DEMO_DIR) --port 7793

demo-shots: demo-build demo-seed    ## Boot yoke + run capture spec → docs/img/*.png
	@YOKE_DEMO_DIR=$(DEMO_DIR) npx playwright test --config scripts/demo/playwright.config.ts

demo-gif:                           ## Regenerate docs/img/yoke-cli-tour.gif
	@pnpm run build && vhs scripts/e2e/capture/setup.tape

demo-all: demo-shots demo-gif       ## Refresh every README asset

demo-clean:
	@rm -rf $(DEMO_DIR)

.PHONY: demo-build demo-seed demo-serve demo-shots demo-gif demo-all demo-clean
