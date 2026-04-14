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
	@FEATURE=$(FEATURE) PHASE=$(PHASE) node scripts/tail-session.js

# tail-session-raw — follow live output from the most recent session log
tail-session-raw:
	@log=$$(FEATURE=$(FEATURE) PHASE=$(PHASE) node scripts/get-log.js) && \
	echo "Tailing: $$log" && \
	tail -f "$$log"

.PHONY: last-status last-output last-logs tail-session tail-session-raw
