# jig Empirical Semantics

Phase γ research deliverable. Documents how jig (the Claude Code profile
tool) behaves when spawned as a child process, for the best-practices
guide. Does NOT affect Process Manager design — the Process Manager is
command-agnostic by contract (D55).

Captured 2026-04-12 using jig 0.1.0, Claude Code 2.1.104, macOS (Darwin
25.3.0, arm64).

---

## 1. Profile resolution

**Config locations:**

| Scope | Path | Created by |
|---|---|---|
| Global | `~/.jig/profiles/<name>.yaml` | `jig profiles create <name> --global` |
| Project | `.jig/profiles/<name>.yaml` (relative to cwd) | `jig init` then `jig profiles create <name>` |

**Resolution order:** project-level shadows global. When a project has a
profile with the same name as a global profile, `jig profiles list` shows
it as `(project)` and `jig run` uses the project copy.

**Profile YAML schema (observed):**

```yaml
name: my-profile
description: optional description
model: sonnet          # optional; valid: opus, sonnet, haiku
effort: high           # optional; defaults to "high" when omitted
permission_mode: default  # optional; valid: default, plan, autoaccept, bypassPermissions
```

No native YAML fields exist for `allowed_tools`, `disallowed_tools`,
`system_prompt`, or `append_system_prompt`. Those must be passed via `--`
passthrough.

**`jig run` overrides:** `--model`, `--effort`, `--permission-mode` flags
on `jig run` override the values in the YAML profile.

---

## 2. Process model: fork, not exec

**Verdict: jig forks claude as a child process (Go `os/exec.Command`).
It does NOT exec-replace itself.**

Observed process tree:

```
PID   PPID  COMM
60275 60273 jig
60279 60275 /Users/jforsythe/.local/bin/claude
```

jig remains alive as the parent for the duration of the claude session.
The binary is compiled Go (confirmed via `file` and `strings` — references
`os/exec.Command`, `exec: killing Cmd`, `exec: not started`).

**What jig does before spawning claude:**

1. Resolves the named profile (project then global).
2. Creates a temp directory under `$TMPDIR/jig-<random>/` containing:
   - `jig-settings.json` — a settings overlay (e.g., plugin enablement).
   - `.claude-plugin/plugin.json` — a plugin manifest derived from the
     profile name and description.
3. Constructs a claude command line with `--settings`, `--plugin-dir`,
   `--effort`, `--permission-mode`, plus any `--` passthrough args.
4. Spawns claude as a child process.
5. On exit, cleans up the temp directory.

**Implications for Yoke:** Because jig is the parent process, Yoke's
Process Manager must track the jig PID, not the claude PID. Signal
delivery and process lifecycle management target jig, which propagates
to claude (see §3 below).

---

## 3. Signal propagation

**Verdict: jig propagates both SIGTERM and SIGINT to the claude child.
Both jig and claude terminate.**

| Signal sent to jig | jig dies? | claude child dies? | jig exit code |
|---|---|---|---|
| SIGTERM | Yes (within 2s) | Yes (within 2s) | 1 |
| SIGINT | Yes (within 2s) | Yes (within 2s) | 1 |

Test methodology: started a long-running `jig run <profile> -- --print
"<long prompt>"`, sent signal to the jig PID, waited 2s, confirmed both
PIDs were gone via `kill -0`.

**Implication for Yoke:** The escalation ladder (SIGTERM → wait →
SIGKILL) works correctly through jig. Sending SIGTERM to the jig PID
terminates both jig and claude. No need to discover or track the inner
claude PID.

---

## 4. Working directory

**Verdict: jig does NOT change the working directory.** The spawned claude
process inherits the caller's cwd.

```
Caller cwd:   /Users/jforsythe/dev/ai/yoke
Claude's cwd: /Users/jforsythe/dev/ai/yoke
```

Confirmed via `jig run <profile> -- --print "process.cwd()"`. The
stream-json `init` event's `cwd` field also matches the caller's cwd.

**Implication for Yoke:** The Process Manager can set `cwd` on the
spawn options and it will propagate through jig to claude unchanged.

---

## 5. Exit codes

| Scenario | Exit code | Error output location |
|---|---|---|
| Profile not found | 1 | stderr: `Error: resolving profile "X": profile "X" not found` |
| Profile not found (near match) | 1 | stderr: `Error: profile "X" not found. Did you mean "Y"?` |
| Invalid profile (bad model/mode) | 1 | stderr: `Error: profile "X" is invalid: validation failed:` with bullet list |
| Claude not on PATH | 1 | stderr: `Error: claude not found in PATH: exec: "claude": executable file not found in $PATH` |
| Claude exits 0 (success) | 0 | — |
| Claude exits non-zero (invalid flag) | 1 | claude's error on stdout/stderr |
| SIGTERM to jig | 1 | — |
| SIGINT to jig | 1 | — |
| `--dry-run` (success) | 0 | Diagnostic output on stdout |

**Key observation:** jig error messages go to stderr with an `Error:`
prefix. The Process Manager's stream-json parser on stdout will not
see them. However, jig-level failures (profile not found, claude not on
PATH) happen *before* any stdout is produced, so the Process Manager will
see the child exit with code 1 and zero stdout lines — the failure
classifier should treat this as a `permanent` failure (no retry).

**Exit code mapping:** jig maps all non-zero claude exits to 1. It does
not preserve claude's original exit code. (This is a jig limitation, not
a Yoke concern — the Process Manager uses stream-json `result` events
for status, not raw exit codes.)

---

## 6. Tool restriction passthrough

**Verdict: `--allowed-tools` and `--disallowed-tools` pass through
unchanged via `--` separator.**

jig has no native YAML fields for tool restrictions. They must be
specified as passthrough args:

```
jig run my-profile -- --allowed-tools "Bash,Read"
jig run my-profile -- --disallowed-tools "Edit,Write"
```

Dry-run output confirms the flags appear in the constructed command line
in the exact position and form they were passed:

```
Command: /Users/jforsythe/.local/bin/claude
   --settings ...
   --plugin-dir ...
   --effort high
   --permission-mode default
   --allowed-tools
   Bash,Read
```

**Implication for Yoke:** When building the command args array for a
jig-based spawn, tool restrictions go after the `--` separator. The
Process Manager's `args` config already supports this — the user places
`--` and the tool flags in their `args` array.

---

## 7. stream-json format passthrough

**Verdict: jig does NOT wrap, modify, or buffer the stream-json output.
The NDJSON lines come directly from claude's stdout, bit-for-bit
identical to a direct `claude` invocation.**

Tested with:

```
jig run test-research -- --print "say hello" --output-format stream-json --verbose
```

The output is the same init → assistant → rate_limit_event → result
sequence documented in `stream-json-semantics.md`. The `plugins` array in
the `init` event includes the jig-generated plugin (`jig-<profile>@inline`),
which is the only observable difference from a bare claude invocation.

**Note:** `--output-format stream-json` requires `--verbose` when used
with `--print`, same as bare claude. jig does not inject `--verbose`
automatically.

**Implication for Yoke:** The stream-json parser needs no jig-specific
handling. The parser works identically whether the child is `claude` or
`jig run <profile> -- claude-flags`.

---

## 8. Temp directory lifecycle

jig creates a temp directory (`$TMPDIR/jig-<random>/`) for each
invocation containing settings and plugin manifests.

| Mode | Temp dir cleaned up? |
|---|---|
| `jig run` (real) | Yes, on exit |
| `jig run --dry-run` | No (persists) |
| `jig profiles export --format plugin` | No (warns user) |

**Implication for Yoke:** No action needed. jig handles its own temp
cleanup on normal and signal-terminated exits. The Process Manager does
not need to track or clean these directories.

---

## Summary for best-practices guide

jig is a transparent wrapper around claude. From the Process Manager's
perspective:

1. **Spawn:** `jig run <profile> -- <claude-args>` — profile args before
   `--`, claude args after.
2. **Process tree:** jig is the parent PID; claude is a child. Track
   the jig PID.
3. **Signals:** SIGTERM/SIGINT to jig → both die. Escalation ladder works.
4. **cwd:** Inherited unchanged.
5. **stdout:** stream-json passes through unmodified.
6. **Exit codes:** 0 = success, 1 = any failure (jig does not preserve
   claude's specific exit code).
7. **Tool flags:** Passthrough via `--` separator.
8. **Temp files:** Self-cleaning.

The Process Manager remains command-agnostic. Users who choose jig
configure `command: "jig"` and `args: ["run", "<profile>", "--", ...]`
in their pipeline config. No special jig support is needed in Yoke code.
