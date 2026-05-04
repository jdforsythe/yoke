#!/usr/bin/env bash
# Gracefully shut down a yoke process.
# Usage: shutdown-yoke.sh <pid>
# Sends SIGINT, waits up to 5 s; then SIGTERM, waits 3 s; then SIGKILL.
# Always exits 0 (best-effort).
set -uo pipefail

PID="${1:-}"
if [[ -z "$PID" ]]; then
  echo "[shutdown] No PID provided — nothing to do." >&2
  exit 0
fi

if ! kill -0 "$PID" 2>/dev/null; then
  echo "[shutdown] Process $PID is not running — nothing to do."
  exit 0
fi

# --- SIGINT ---
echo "[shutdown] Sending SIGINT to pid=$PID ..."
kill -INT "$PID" 2>/dev/null || true

for i in $(seq 1 5); do
  sleep 1
  kill -0 "$PID" 2>/dev/null || { echo "[shutdown] Process $PID exited after SIGINT."; exit 0; }
done

# --- SIGTERM ---
echo "[shutdown] Process still alive; sending SIGTERM to pid=$PID ..."
kill -TERM "$PID" 2>/dev/null || true

for i in $(seq 1 3); do
  sleep 1
  kill -0 "$PID" 2>/dev/null || { echo "[shutdown] Process $PID exited after SIGTERM."; exit 0; }
done

# --- SIGKILL ---
echo "[shutdown] Process still alive; sending SIGKILL to pid=$PID ..."
kill -KILL "$PID" 2>/dev/null || true
sleep 1

if kill -0 "$PID" 2>/dev/null; then
  echo "[shutdown] WARNING: Process $PID could not be killed." >&2
else
  echo "[shutdown] Process $PID killed."
fi

exit 0
