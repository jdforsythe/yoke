LOG_DIR := .yoke/logs

# last-status [PHASE=implement|review] [FEATURE=<id>]
# Prints PASS/FAIL verdict for the most recent matching session.
# Defaults to the most recent log of any phase/feature.
last-status:
	@log=$$(ls -t $(LOG_DIR)/$(if $(PHASE),*$(PHASE)*,*)$(if $(FEATURE),*$(FEATURE)*,*).jsonl 2>/dev/null | head -1); \
	if [ -z "$$log" ]; then echo "No matching logs in $(LOG_DIR)"; exit 1; fi; \
	echo "Log: $$log"; \
	python3 -c " \
import sys, json; \
obj = json.loads(open('$$log').readlines()[-1]); \
subtype = obj.get('subtype',''); \
is_error = obj.get('is_error', False); \
result = obj.get('result',''); \
terminal = obj.get('terminal_reason',''); \
fail_count = result.count(': FAIL'); \
blocking = 'Blocking Issues' in result and 'None' not in result.split('Blocking Issues')[-1].split('###')[0]; \
print(f'Session : {obj.get(\"session_id\",\"?\")}'); \
print(f'Exit    : {subtype} / terminal={terminal} / is_error={is_error}'); \
print(f'Turns   : {obj.get(\"num_turns\",\"?\")}  Cost: \$${obj.get(\"total_cost_usd\",0):.4f}'); \
verdict = 'FAIL' if (subtype != 'success' or is_error or fail_count > 0 or blocking) else 'PASS'; \
print(f'Criteria: {fail_count} FAIL(s)  Blocking: {\"YES\" if blocking else \"none\"}'); \
print(f''); \
print(f'Verdict : {verdict}'); \
"

# last-output [PHASE=implement|review] [FEATURE=<id>]
# Prints the full result text from the most recent matching session.
last-output:
	@log=$$(ls -t $(LOG_DIR)/$(if $(PHASE),*$(PHASE)*,*)$(if $(FEATURE),*$(FEATURE)*,*).jsonl 2>/dev/null | head -1); \
	if [ -z "$$log" ]; then echo "No matching logs in $(LOG_DIR)"; exit 1; fi; \
	echo "Log: $$log"; echo ""; \
	python3 -c " \
import sys, json; \
obj = json.loads(open('$$log').readlines()[-1]); \
print(obj.get('result', '(no result field)')); \
"

# last-logs — list all session logs, newest first
last-logs:
	@ls -lt $(LOG_DIR)/*.jsonl 2>/dev/null | awk '{print $$NF}' || echo "No logs in $(LOG_DIR)"

.PHONY: last-status last-output last-logs
