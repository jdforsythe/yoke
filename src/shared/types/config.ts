/**
 * TypeScript types for .yoke.yml configuration.
 *
 * Derived from docs/design/schemas/yoke-config.schema.json (JSON Schema draft-2020-12).
 * Version "1" is the only supported version.
 *
 * Two forms:
 *   RawConfig      — direct YAML parse output; path fields may be relative strings.
 *   ResolvedConfig — RawConfig with all path fields guaranteed to be absolute,
 *                    plus a `configDir` field. All downstream modules consume
 *                    ResolvedConfig only.
 *
 * Resolved at load time (relative → absolute, base = .yoke.yml directory):
 *   phases[*].prompt_template
 *   phases[*].cwd                          (if present)
 *   phases[*].output_artifacts[*].schema   (if present)
 *   worktrees.teardown.script              (if present)
 *
 * NOT resolved (runtime-relative to the worktree, unknown at load time):
 *   pipeline.stages[*].items_from
 *   phases[*].output_artifacts[*].path
 */

// ---------------------------------------------------------------------------
// Action grammar (mirrors docs/design/schemas/pre-post-action-grammar.md)
// ---------------------------------------------------------------------------

export type RetryMode =
  | 'continue'
  | 'fresh_with_failure_summary'
  | 'fresh_with_diff'
  | 'awaiting_user';

export type ActionValue =
  | 'continue'
  | 'stop-and-ask'
  | 'stop'
  | { goto: string; max_revisits?: number }
  | { retry: { mode: 'continue' | 'fresh_with_failure_summary' | 'fresh_with_diff'; max: number } }
  | { fail: { reason: string } };

/** Keys are exit-code strings ("0"–"255") or the wildcard "*". */
export type ActionsMap = Record<string, ActionValue>;

// ---------------------------------------------------------------------------
// Pre / post commands
// ---------------------------------------------------------------------------

export interface PrePostCommand {
  name: string;
  /** argv-form; spawned with shell: false */
  run: string[];
  timeout_s?: number;
  env?: Record<string, string>;
  actions: ActionsMap;
}

// ---------------------------------------------------------------------------
// Phase
// ---------------------------------------------------------------------------

export interface OutputArtifact {
  /** Relative to worktree (not resolved at load time). */
  path: string;
  /** Path to a JSON Schema file. Absolute in ResolvedConfig. */
  schema?: string;
  required?: boolean;
}

export interface Heartbeat {
  /**
   * Interval in seconds for the liveness probe (kill(pid, 0)).
   * Default: 30 s.
   */
  liveness_interval_s?: number;
  /** Seconds of stdout silence before the stream-activity watchdog warns. Default: 90 s. */
  activity_timeout_s?: number;
  /** Tool-name → wall-clock budget in seconds. */
  per_tool_budgets?: Record<string, number>;
}

export interface Phase {
  command: string;
  args: string[];
  env?: Record<string, string>;
  /** Absolute in ResolvedConfig (if present). */
  cwd?: string;
  /** Absolute in ResolvedConfig. */
  prompt_template: string;
  output_artifacts?: OutputArtifact[];
  max_outer_retries?: number;
  retry_ladder?: RetryMode[];
  heartbeat?: Heartbeat;
  pre?: PrePostCommand[];
  post?: PrePostCommand[];
}

// ---------------------------------------------------------------------------
// Pipeline / stages
// ---------------------------------------------------------------------------

export interface ItemsDisplay {
  title?: string;
  subtitle?: string;
  description?: string;
}

export interface Stage {
  id: string;
  run: 'once' | 'per-item';
  /** Ordered phase keys referencing the top-level phases map. */
  phases: string[];
  needs_approval?: boolean;
  /** Relative to worktree — NOT resolved at load time. */
  items_from?: string;
  items_list?: string;
  items_id?: string;
  items_depends_on?: string;
  items_display?: ItemsDisplay;
}

export interface Pipeline {
  stages: Stage[];
}

// ---------------------------------------------------------------------------
// Top-level optional sections
// ---------------------------------------------------------------------------

export interface Template {
  name: string;
  /** Optional human-readable description shown in the template picker UI. */
  description?: string;
}

export interface WorktreesBootstrap {
  commands?: string[];
}

export interface WorktreesTeardown {
  /** Absolute in ResolvedConfig (if present). */
  script?: string;
}

export interface Worktrees {
  base_dir?: string;
  branch_prefix?: string;
  auto_cleanup?: boolean;
  cleanup_tool?: 'git' | 'lazyworktree' | 'custom';
  bootstrap?: WorktreesBootstrap;
  teardown?: WorktreesTeardown;
}

export interface NotificationMechanism {
  type: 'browser_push' | 'macos_native';
}

export interface Notifications {
  enabled?: boolean;
  severity_map?: Record<string, string>;
  mechanisms?: NotificationMechanism[];
}

export interface Github {
  enabled?: boolean;
  auto_pr?: boolean;
  pr_target_branch?: string;
  auth_order?: Array<'env:GITHUB_TOKEN' | 'gh:auth:token'>;
  attach_artifacts_to_pr?: boolean;
  link_issues?: boolean;
}

export type SqliteRetention = 'forever' | { max_age_days: number };

export interface RetentionStreamJsonLogs {
  max_age_days?: number;
  max_total_bytes?: number;
}

export interface Retention {
  sqlite?: SqliteRetention;
  stream_json_logs?: RetentionStreamJsonLogs;
  worktrees?: 'workflow-completion' | 'manual' | 'on-disk-pressure';
}

export interface Logging {
  retain_stream_json?: boolean;
}

export interface Runtime {
  keep_awake?: boolean;
}

export interface RateLimit {
  handling?: 'passive';
  /** v1.1 only; rejected at load time in v1 by the schema. */
  usage_pause_threshold?: number;
}

export interface Ui {
  port?: number;
  bind?: '127.0.0.1';
  auth?: false;
}

// ---------------------------------------------------------------------------
// Root config types
// ---------------------------------------------------------------------------

/**
 * Raw config as parsed from .yoke.yml — before path resolution.
 * Relative path fields are still relative strings in this type.
 */
export interface RawConfig {
  version: string;
  template: Template;
  pipeline: Pipeline;
  /** Keys are phase names referenced by pipeline stages. */
  phases: Record<string, Phase>;
  worktrees?: Worktrees;
  notifications?: Notifications;
  github?: Github;
  retention?: Retention;
  logging?: Logging;
  runtime?: Runtime;
  rate_limit?: RateLimit;
  ui?: Ui;
  safety_mode?: 'strict' | 'default' | 'yolo';
}

/**
 * Config with all relative paths resolved to absolute paths, using the
 * .yoke.yml directory as the base. All downstream modules consume only
 * this type — never RawConfig.
 */
export type ResolvedConfig = RawConfig & {
  /** Absolute path of the directory containing .yoke.yml. */
  configDir: string;
};
