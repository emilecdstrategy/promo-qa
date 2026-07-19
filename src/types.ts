export type Status =
  | "passed"
  | "failed"
  | "error"
  | "processing"
  | "skipped_unregistered"
  | "skipped_unchanged";

export interface Store {
  id: string;
  store_slug: string;
  shop_domain: string;
  display_name: string;
  active: boolean;
  has_token: boolean;
  created_at: string;
  updated_at: string;
}

export interface AutomationRun {
  id: string;
  trigger: "cron" | "manual";
  dry_run: boolean;
  requested_task_gid: string | null;
  requested_by: string | null;
  status: "running" | "completed" | "partial" | "error";
  total_tasks: number;
  passed_count: number;
  failed_count: number;
  skipped_count: number;
  error_count: number;
  started_at: string;
  completed_at: string | null;
  duration_ms: number | null;
  error_message: string | null;
}

export interface ActivityItem {
  id: string;
  run_id: string;
  task_gid: string;
  task_name: string | null;
  parent_task_gid: string | null;
  store_slug: string | null;
  theme_id: string | null;
  published_theme_id: string | null;
  status: Status;
  action_taken: string;
  confidence: number | null;
  details: unknown;
  error_message: string | null;
  started_at: string;
  completed_at: string;
  duration_ms: number;
  automation_runs: Pick<
    AutomationRun,
    "trigger" | "dry_run" | "requested_by" | "status" | "started_at"
  >;
}

export interface OverviewData {
  automation: { enabled: boolean; updatedAt: string | null };
  stores: { total: number; active: number; configured: number };
  lastRun: AutomationRun | null;
  nextRunAt: string;
  recent: {
    total: number;
    passed: number;
    failed: number;
    errors: number;
    skipped: number;
  };
  configuration: {
    scheduler: boolean;
    smtp: boolean;
    asana: boolean;
    anthropic: boolean;
  };
}

export interface RunResponse {
  ok: boolean;
  runId: string;
  dryRun: boolean;
  processed: number;
  results: Array<{
    taskGid: string;
    taskName?: string;
    storeSlug?: string;
    themeId?: string;
    publishedThemeId?: string;
    status: Status;
    action: string;
    confidence?: number;
    details?: unknown;
  }>;
}
