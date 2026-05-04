#!/usr/bin/env bash
# Yoke end-to-end test driver.
# Runs scenario-a and scenario-b sequentially, each in a fresh tmpdir.
# Usage: bash scripts/e2e/run.sh
# Env:
#   YOKE_E2E_PORT=<N>   (default 7791)
#   YOKE_E2E_KEEP=1     keep tmpdirs even on success (for post-mortem)
set -uo pipefail

# ---------------------------------------------------------------------------
# 0. Resolve repo root from BASH_SOURCE
# ---------------------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# ---------------------------------------------------------------------------
# 1. Pre-flight checks
# ---------------------------------------------------------------------------
MISSING=()
for cmd in claude node git; do
  command -v "$cmd" &>/dev/null || MISSING+=("$cmd")
done
if [[ ${#MISSING[@]} -gt 0 ]]; then
  echo "ERROR: Required commands not found on PATH: ${MISSING[*]}" >&2
  exit 1
fi

DIST_ENTRY="$REPO_ROOT/dist/cli/index.js"
if [[ ! -f "$DIST_ENTRY" ]]; then
  echo "ERROR: $DIST_ENTRY not found. Run 'pnpm run build' first." >&2
  exit 2
fi

# ---------------------------------------------------------------------------
# 2. Port check
# ---------------------------------------------------------------------------
PORT="${YOKE_E2E_PORT:-7791}"
if nc -z 127.0.0.1 "$PORT" 2>/dev/null; then
  echo "ERROR: Port $PORT is already in use. Set YOKE_E2E_PORT to a free port." >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# 3. State tracking
# ---------------------------------------------------------------------------
YOKE_PID=""
TMPDIR_A=""
TMPDIR_B=""
SCENARIO_A_STATUS="SKIP"
SCENARIO_B_STATUS="SKIP"

# ---------------------------------------------------------------------------
# 4. Cleanup trap (always runs)
# ---------------------------------------------------------------------------
cleanup() {
  local exit_code=$?

  # Shut down yoke if still running
  if [[ -n "$YOKE_PID" ]] && kill -0 "$YOKE_PID" 2>/dev/null; then
    echo "[cleanup] Stopping yoke pid=$YOKE_PID ..."
    bash "$REPO_ROOT/scripts/e2e/lib/shutdown-yoke.sh" "$YOKE_PID" || true
    YOKE_PID=""
  fi

  # Decide whether to remove tmpdirs
  local overall_pass=0
  [[ "$SCENARIO_A_STATUS" == "PASS" && "$SCENARIO_B_STATUS" == "PASS" ]] || overall_pass=1

  if [[ $overall_pass -eq 0 && "${YOKE_E2E_KEEP:-0}" != "1" ]]; then
    echo "[cleanup] Both scenarios passed — removing tmpdirs."
    [[ -n "$TMPDIR_A" && -d "$TMPDIR_A" ]] && rm -rf "$TMPDIR_A"
    [[ -n "$TMPDIR_B" && -d "$TMPDIR_B" ]] && rm -rf "$TMPDIR_B"
  else
    echo "[cleanup] Leaving tmpdirs for inspection:"
    [[ -n "$TMPDIR_A" ]] && echo "  scenario-a: $TMPDIR_A"
    [[ -n "$TMPDIR_B" ]] && echo "  scenario-b: $TMPDIR_B"
  fi
}
trap cleanup EXIT

# ---------------------------------------------------------------------------
# 5. Helper: wait for yoke HTTP to be ready (up to 30 s)
# ---------------------------------------------------------------------------
wait_for_yoke() {
  local deadline=$(( $(date +%s) + 30 ))
  echo "[wait] Polling http://127.0.0.1:$PORT/api/templates ..."
  while true; do
    if curl -fs "http://127.0.0.1:$PORT/api/templates" >/dev/null 2>&1; then
      echo "[wait] Yoke is ready."
      return 0
    fi
    if [[ $(date +%s) -ge $deadline ]]; then
      echo "ERROR: Yoke did not become ready within 30 seconds." >&2
      return 1
    fi
    sleep 1
  done
}

# ---------------------------------------------------------------------------
# 6. Helper: extract .workflowId from JSON (jq or node fallback)
# ---------------------------------------------------------------------------
extract_workflow_id() {
  local json="$1"
  if command -v jq &>/dev/null; then
    printf '%s' "$json" | jq -r '.workflowId'
  else
    node -e "process.stdout.write(JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')).workflowId)" <<< "$json"
  fi
}

# ---------------------------------------------------------------------------
# 7. Run each scenario
# ---------------------------------------------------------------------------
OVERALL_EXIT=0

for NAME in scenario-a scenario-b; do
  echo ""
  echo "============================================================"
  echo "=== Scenario $NAME"
  echo "============================================================"

  FIXTURE_DIR="$REPO_ROOT/scripts/e2e/fixtures/$NAME"

  # --- a. Make tmpdir ---
  TMPDIR_OUT="$(bash "$REPO_ROOT/scripts/e2e/lib/setup-tmpdir.sh" "$FIXTURE_DIR")"
  if [[ "$NAME" == "scenario-a" ]]; then
    TMPDIR_A="$TMPDIR_OUT"
    CURRENT_TMPDIR="$TMPDIR_A"
  else
    TMPDIR_B="$TMPDIR_OUT"
    CURRENT_TMPDIR="$TMPDIR_B"
  fi

  echo "=== Scenario $NAME — $CURRENT_TMPDIR ==="

  # --- b. Start yoke in background ---
  echo "[run] Starting yoke --template $NAME --port $PORT --config-dir $CURRENT_TMPDIR ..."
  "$REPO_ROOT/bin/yoke" start \
    --template "$NAME" \
    --port "$PORT" \
    --config-dir "$CURRENT_TMPDIR" \
    > "$CURRENT_TMPDIR/yoke.log" 2>&1 &
  YOKE_PID=$!
  echo "[run] Yoke pid=$YOKE_PID"

  # --- c. Wait for HTTP ---
  if ! wait_for_yoke; then
    echo "Scenario $NAME: FAIL (yoke did not start)"
    echo "[yoke.log tail]"
    tail -20 "$CURRENT_TMPDIR/yoke.log" || true
    OVERALL_EXIT=1
    if [[ "$NAME" == "scenario-a" ]]; then SCENARIO_A_STATUS="FAIL"; else SCENARIO_B_STATUS="FAIL"; fi
    bash "$REPO_ROOT/scripts/e2e/lib/shutdown-yoke.sh" "$YOKE_PID" || true
    YOKE_PID=""
    continue
  fi

  # --- d. POST workflow ---
  echo "[run] Creating workflow e2e-$NAME ..."
  WORKFLOW_JSON="$(curl -fs -X POST \
    "http://127.0.0.1:$PORT/api/workflows" \
    -H "content-type: application/json" \
    -d "{\"templateName\":\"$NAME\",\"name\":\"e2e-$NAME\"}")" || {
      echo "ERROR: POST /api/workflows failed." >&2
      echo "Scenario $NAME: FAIL (workflow POST failed)"
      echo "[yoke.log tail]"
      tail -20 "$CURRENT_TMPDIR/yoke.log" || true
      OVERALL_EXIT=1
      if [[ "$NAME" == "scenario-a" ]]; then SCENARIO_A_STATUS="FAIL"; else SCENARIO_B_STATUS="FAIL"; fi
      bash "$REPO_ROOT/scripts/e2e/lib/shutdown-yoke.sh" "$YOKE_PID" || true
      YOKE_PID=""
      continue
    }

  WF_ID="$(extract_workflow_id "$WORKFLOW_JSON")"
  if [[ -z "$WF_ID" || "$WF_ID" == "null" ]]; then
    echo "ERROR: Could not extract workflowId from response: $WORKFLOW_JSON" >&2
    echo "Scenario $NAME: FAIL (no workflowId)"
    OVERALL_EXIT=1
    if [[ "$NAME" == "scenario-a" ]]; then SCENARIO_A_STATUS="FAIL"; else SCENARIO_B_STATUS="FAIL"; fi
    bash "$REPO_ROOT/scripts/e2e/lib/shutdown-yoke.sh" "$YOKE_PID" || true
    YOKE_PID=""
    continue
  fi
  echo "[run] Workflow id=$WF_ID"

  # --- e. Poll until terminal ---
  echo "[run] Polling workflow $WF_ID (timeout 300s) ..."
  if ! node "$REPO_ROOT/scripts/e2e/lib/poll-workflow.mjs" \
      --port "$PORT" \
      --workflow-id "$WF_ID" \
      --timeout 300; then
    POLL_EXIT=$?
    echo "Scenario $NAME: FAIL (poll exited $POLL_EXIT)"
    echo "[yoke.log tail]"
    tail -30 "$CURRENT_TMPDIR/yoke.log" || true
    OVERALL_EXIT=1
    if [[ "$NAME" == "scenario-a" ]]; then SCENARIO_A_STATUS="FAIL"; else SCENARIO_B_STATUS="FAIL"; fi
    bash "$REPO_ROOT/scripts/e2e/lib/shutdown-yoke.sh" "$YOKE_PID" || true
    YOKE_PID=""
    continue
  fi

  # --- f. Verify ---
  echo "[run] Running verify-$NAME.mjs ..."
  if node "$REPO_ROOT/scripts/e2e/lib/verify-$NAME.mjs" "$CURRENT_TMPDIR" "$WF_ID"; then
    echo "Scenario $NAME: PASS"
    if [[ "$NAME" == "scenario-a" ]]; then SCENARIO_A_STATUS="PASS"; else SCENARIO_B_STATUS="PASS"; fi
  else
    echo "Scenario $NAME: FAIL (verification failed)"
    OVERALL_EXIT=1
    if [[ "$NAME" == "scenario-a" ]]; then SCENARIO_A_STATUS="FAIL"; else SCENARIO_B_STATUS="FAIL"; fi
  fi

  # --- g. Log tail regardless ---
  echo "[yoke.log tail]"
  tail -20 "$CURRENT_TMPDIR/yoke.log" || true

  # --- h. Shutdown yoke ---
  bash "$REPO_ROOT/scripts/e2e/lib/shutdown-yoke.sh" "$YOKE_PID" || true
  YOKE_PID=""

done

# ---------------------------------------------------------------------------
# 8. Final summary
# ---------------------------------------------------------------------------
echo ""
echo "============================================================"
echo "E2E Summary"
echo "  scenario-a: $SCENARIO_A_STATUS"
echo "  scenario-b: $SCENARIO_B_STATUS"
echo "============================================================"

exit $OVERALL_EXIT
