import { createClient } from "npm:@supabase/supabase-js@2";
import { AnthropicClient } from "../_shared/ai.ts";
import { AsanaClient, isPromoQaTask, isDueWithinDays, stripHtml } from "../_shared/asana.ts";
import {
  sendAlertEmail,
  type SmtpConfig,
  getSmtpConfig,
} from "../_shared/email.ts";
import { getIndexJson, getPublishedThemeId } from "../_shared/shopify.ts";
import type {
  AsanaTask,
  StoreCredential,
  TaskContext,
} from "../_shared/types.ts";
import {
  applyDeterministicGuards,
  collectBannerBlocks,
  formatFailureComment,
  matchExpectedBanners,
} from "../_shared/verify.ts";

const ASANA_WORKSPACE_GID = Deno.env.get("ASANA_WORKSPACE_GID") ??
  "1201007545370748";
const EMIL_ASANA_GID = Deno.env.get("ASANA_ASSIGNEE_GID") ??
  "1206406200377321";
const CONFIDENCE_THRESHOLD = Number(
  Deno.env.get("QA_CONFIDENCE_THRESHOLD") ?? "0.85",
);

const requiredEnv = (name: string): string => {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
};

const supabase = createClient(
  requiredEnv("SUPABASE_URL"),
  requiredEnv("SUPABASE_SERVICE_ROLE_KEY"),
  { auth: { persistSession: false, autoRefreshToken: false } },
);
const asana = new AsanaClient(requiredEnv("ASANA_ACCESS_TOKEN"));
const anthropic = new AnthropicClient(
  requiredEnv("ANTHROPIC_API_KEY"),
  Deno.env.get("ANTHROPIC_MODEL") ?? "claude-sonnet-4-5",
);
const encryptionKey = requiredEnv("STORE_TOKEN_ENCRYPTION_KEY");
const runnerSecret = requiredEnv("QA_RUNNER_SECRET");
const smtp = getSmtpConfig((name) => Deno.env.get(name));
const MISSING_LINK_DUE_WINDOW_DAYS = 3;
const DESIGN_READINESS_THRESHOLD = 0.7;
const MISSING_LINK_COMMENT =
  "Hi! This promo QA task is due soon, but I don't see a Shopify theme editor / promo scheduler link in the task notes yet. Could you add it when the promo is ready to schedule?";

interface RunRequest {
  taskGid?: string;
  dryRun?: boolean;
  force?: boolean;
}

interface RunResult {
  taskGid: string;
  taskName?: string;
  parentTaskGid?: string;
  storeSlug?: string;
  themeId?: string;
  publishedThemeId?: string;
  status: string;
  action: string;
  confidence?: number;
  details?: unknown;
}

Deno.serve(async (request) => {
  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  if (!safeEqual(request.headers.get("x-qa-runner-secret") ?? "", runnerSecret)) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  let automationRunId: string | null = null;
  const requestStartedAt = Date.now();
  try {
    const input = await request.json().catch(() => ({})) as RunRequest;
    const trigger = request.headers.get("x-qa-trigger") === "cron"
      ? "cron"
      : "manual";

    if (trigger === "cron" && !await isAutomationEnabled()) {
      automationRunId = await createAutomationRun({
        trigger,
        dryRun: false,
        requestedBy: "cron",
      });
      await finishAutomationRun(automationRunId, [], requestStartedAt);
      return Response.json({
        ok: true,
        automationEnabled: false,
        processed: 0,
        results: [],
        message: "Automation is turned off. Scheduled checks were skipped.",
      });
    }

    automationRunId = await createAutomationRun({
      trigger,
      dryRun: Boolean(input.dryRun),
      taskGid: input.taskGid,
      requestedBy: request.headers.get("x-qa-requested-by") ?? trigger,
    });
    const tasks = input.taskGid
      ? [await asana.getTask(input.taskGid)]
      : (await asana.listIncompleteTasks(EMIL_ASANA_GID, ASANA_WORKSPACE_GID))
        .filter(isPromoQaTask);

    const results: RunResult[] = [];
    for (const task of tasks) {
      const taskStartedAt = Date.now();
      let result: RunResult;
      try {
        result = await processTask(task, input);
      } catch (error) {
        const message = errorMessage(error);
        if (!input.dryRun) {
          await recordRun({
            task,
            status: "error",
            action: "emailed",
            errorMessage: message,
          });
          await notify(
            smtp,
            `Promo QA error: ${task.name}`,
            `Task ${task.gid} could not be processed.\n\n${message}`,
          );
        }
        result = {
          taskGid: task.gid,
          taskName: task.name,
          status: "error",
          action: "none",
          details: message,
        };
      }
      results.push(result);
      await recordAutomationRunItem(
        automationRunId,
        result,
        taskStartedAt,
      );
    }

    await finishAutomationRun(
      automationRunId,
      results,
      requestStartedAt,
    );
    return Response.json({
      ok: results.every((result) => result.status !== "error"),
      runId: automationRunId,
      dryRun: Boolean(input.dryRun),
      processed: results.length,
      results,
    });
  } catch (error) {
    if (automationRunId) {
      await failAutomationRun(
        automationRunId,
        errorMessage(error),
        requestStartedAt,
      ).catch(console.error);
    }
    return Response.json({ ok: false, error: errorMessage(error) }, {
      status: 500,
    });
  }
});

async function processTask(
  task: AsanaTask,
  input: RunRequest,
): Promise<RunResult> {
  const context = await asana.getTaskContext(task.gid);
  const resultMeta = {
    taskGid: task.gid,
    taskName: context.task.name,
    parentTaskGid: context.parent?.gid ?? context.task.parent?.gid,
    storeSlug: context.editorTarget?.storeSlug,
    themeId: context.editorTarget?.themeId,
  };

  if (!context.editorTarget) {
    return handleMissingEditorUrl(context, input, resultMeta);
  }

  const store = await getStore(context.editorTarget.storeSlug);

  if (!store) {
    const message =
      `Theme Access is not configured for ${context.editorTarget.shopDomain}.\n` +
      `Asana task: ${context.task.name} (${context.task.gid})`;
    if (!input.dryRun) {
      await notify(
        smtp,
        `Promo QA store needs setup: ${context.editorTarget.storeSlug}`,
        message,
      );
      await recordRun({
        context,
        task: context.task,
        status: "skipped_unregistered",
        action: "emailed",
        verdict: { reason: message },
      });
    }
    return {
      ...resultMeta,
      status: "skipped_unregistered",
      action: input.dryRun ? "none" : "emailed",
      details: message,
    };
  }

  if (!input.force && !input.dryRun && await alreadyProcessed(context.task)) {
    return {
      ...resultMeta,
      status: "skipped_unchanged",
      action: "none",
    };
  }

  if (!input.dryRun) {
    await recordRun({
      context,
      task: context.task,
      status: "processing",
      action: "none",
    });
  }

  const [template, publishedThemeId] = await Promise.all([
    getIndexJson(store, context.editorTarget.themeId),
    getPublishedThemeId(store),
  ]);
  const spec = await anthropic.parsePromoSpec({
    taskName: context.task.name,
    taskNotes: context.task.notes ?? context.task.html_notes ?? "",
    parentName: context.parent?.name,
    parentNotes: context.parent?.notes ?? context.parent?.html_notes,
    currentDate: new Date().toISOString().slice(0, 10),
  });
  const blocks = collectBannerBlocks(
    template,
    context.editorTarget.sectionHint,
  );
  const matches = matchExpectedBanners(
    spec.banners,
    blocks,
    context.editorTarget.blockHint,
  );
  const aiVerdict = await anthropic.verifyCandidates({
    spec,
    candidates: matches,
    configuredThemeId: context.editorTarget.themeId,
    publishedThemeId,
  });
  const verdict = applyDeterministicGuards(
    aiVerdict,
    matches,
    context.editorTarget.themeId,
    publishedThemeId,
  );
  const confidentlyPassed = verdict.passed &&
    verdict.confidence >= CONFIDENCE_THRESHOLD &&
    spec.confidence >= CONFIDENCE_THRESHOLD;

  if (input.dryRun) {
    return {
      ...resultMeta,
      publishedThemeId,
      status: confidentlyPassed ? "passed" : "failed",
      action: "none",
      confidence: Math.min(spec.confidence, verdict.confidence),
      details: { spec, matches, verdict, publishedThemeId },
    };
  }

  if (confidentlyPassed) {
    await asana.completeTask(task.gid);
    await recordRun({
      context,
      task: await asana.getTask(task.gid),
      status: "passed",
      action: "completed",
      verdict: { spec, verdict, publishedThemeId },
      confidence: Math.min(spec.confidence, verdict.confidence),
    });
    return {
      ...resultMeta,
      publishedThemeId,
      status: "passed",
      action: "completed",
      confidence: Math.min(spec.confidence, verdict.confidence),
      details: verdict,
    };
  }

  if (spec.confidence < CONFIDENCE_THRESHOLD) {
    verdict.warnings.push(
      `The Asana specification was ambiguous (${
        Math.round(spec.confidence * 100)
      }% confidence).`,
      ...spec.ambiguities,
    );
  }
  await asana.addQaComment(
    task.gid,
    context.creator,
    formatFailureComment(verdict),
  );
  await recordRun({
    context,
    task: await asana.getTask(task.gid),
    status: "failed",
    action: "commented",
    verdict: { spec, verdict, publishedThemeId },
    confidence: Math.min(spec.confidence, verdict.confidence),
  });
  return {
    ...resultMeta,
    publishedThemeId,
    status: "failed",
    action: "commented",
    confidence: Math.min(spec.confidence, verdict.confidence),
    details: verdict,
  };
}

async function handleMissingEditorUrl(
  context: TaskContext,
  input: RunRequest,
  resultMeta: Pick<
    RunResult,
    "taskGid" | "taskName" | "parentTaskGid" | "storeSlug" | "themeId"
  >,
): Promise<RunResult> {
  const waitingMessage =
    "Waiting for a Shopify theme editor / promo scheduler link in the task notes.";
  const dueSoon = isDueWithinDays(context.task, MISSING_LINK_DUE_WINDOW_DAYS);

  if (!dueSoon) {
    return {
      ...resultMeta,
      status: "skipped_not_ready",
      action: "none",
      details: waitingMessage,
    };
  }

  const designContext = await asana.getPromoDesignContext(context.parent);
  const designAssessment = await anthropic.assessDesignReadiness({
    qaTaskName: context.task.name,
    qaTaskNotes: stripHtml(context.task.notes ?? context.task.html_notes ?? ""),
    parentName: context.parent?.name,
    parentNotes: stripHtml(context.parent?.notes ?? context.parent?.html_notes ?? ""),
    subtasks: designContext.subtasks,
    comments: designContext.comments,
  });
  const designReady = designAssessment.designed &&
    designAssessment.confidence >= DESIGN_READINESS_THRESHOLD;

  if (!designReady) {
    return {
      ...resultMeta,
      status: "skipped_not_ready",
      action: "none",
      details: {
        reason: "Promo design still appears in progress on the parent task.",
        waitingFor: "design",
        designAssessment,
      },
    };
  }

  const shouldComment = !input.dryRun &&
    (input.force || !await missingLinkAlreadyCommented(context.task));
  if (shouldComment) {
    await asana.addQaComment(
      context.task.gid,
      context.creator,
      MISSING_LINK_COMMENT,
    );
    await recordRun({
      context,
      task: context.task,
      status: "skipped_not_ready",
      action: "commented",
      verdict: {
        reason: waitingMessage,
        dueSoon: true,
        designAssessment,
      },
    });
  }

  return {
    ...resultMeta,
    status: "skipped_not_ready",
    action: shouldComment ? "commented" : "none",
    details: {
      reason: waitingMessage,
      dueSoon: true,
      designAssessment,
      notifiedCreator: shouldComment,
    },
  };
}

async function missingLinkAlreadyCommented(task: AsanaTask): Promise<boolean> {
  const { data, error } = await supabase
    .from("qa_runs")
    .select("status,action_taken,source_modified_at")
    .eq("asana_task_gid", task.gid)
    .maybeSingle();
  if (error) throw error;
  if (!data || data.status !== "skipped_not_ready" || data.action_taken !== "commented") {
    return false;
  }
  if (!task.modified_at || !data.source_modified_at) return true;
  return new Date(data.source_modified_at).getTime() >=
    new Date(task.modified_at).getTime();
}

async function isAutomationEnabled(): Promise<boolean> {
  const { data, error } = await supabase.rpc("get_promo_qa_automation_enabled");
  if (error) throw error;
  return Boolean(data);
}

async function getStore(storeSlug: string): Promise<StoreCredential | null> {
  const { data, error } = await supabase.rpc("get_promo_qa_store", {
    p_store_slug: storeSlug,
    p_encryption_key: encryptionKey,
  });
  if (error) throw error;
  return (data?.[0] as StoreCredential | undefined) ?? null;
}

async function alreadyProcessed(task: AsanaTask): Promise<boolean> {
  const { data, error } = await supabase
    .from("qa_runs")
    .select("status,source_modified_at")
    .eq("asana_task_gid", task.gid)
    .maybeSingle();
  if (error) throw error;
  if (!data || data.status === "error" || data.status === "processing") {
    return false;
  }
  if (!task.modified_at || !data.source_modified_at) return true;
  return new Date(data.source_modified_at).getTime() >=
    new Date(task.modified_at).getTime();
}

async function recordRun(input: {
  task: AsanaTask;
  context?: TaskContext;
  status: "processing" | "passed" | "failed" | "skipped_unregistered" | "skipped_unchanged" | "skipped_not_ready" | "error";
  action: "completed" | "commented" | "emailed" | "none";
  verdict?: unknown;
  confidence?: number;
  errorMessage?: string;
}): Promise<void> {
  const { error } = await supabase.from("qa_runs").upsert({
    asana_task_gid: input.task.gid,
    parent_task_gid: input.context?.parent?.gid ?? input.task.parent?.gid ??
      null,
    source_modified_at: input.task.modified_at ?? null,
    store_slug: input.context?.editorTarget.storeSlug ?? null,
    theme_id: input.context?.editorTarget.themeId ?? null,
    status: input.status,
    verdict_json: input.verdict ?? {},
    confidence: input.confidence ?? null,
    action_taken: input.action,
    error_message: input.errorMessage ?? null,
    updated_at: new Date().toISOString(),
  }, { onConflict: "asana_task_gid" });
  if (error) throw error;
}

async function createAutomationRun(input: {
  trigger: "cron" | "manual";
  dryRun: boolean;
  taskGid?: string;
  requestedBy: string;
}): Promise<string> {
  const { data, error } = await supabase.from("automation_runs").insert({
    trigger: input.trigger,
    dry_run: input.dryRun,
    requested_task_gid: input.taskGid ?? null,
    requested_by: input.requestedBy,
  }).select("id").single();
  if (error) throw error;
  return data.id;
}

async function recordAutomationRunItem(
  runId: string,
  result: RunResult,
  startedAt: number,
): Promise<void> {
  const completedAt = new Date();
  const { error } = await supabase.from("automation_run_items").insert({
    run_id: runId,
    task_gid: result.taskGid,
    task_name: result.taskName ?? null,
    parent_task_gid: result.parentTaskGid ?? null,
    store_slug: result.storeSlug ?? null,
    theme_id: result.themeId ?? null,
    published_theme_id: result.publishedThemeId ?? null,
    status: result.status,
    action_taken: result.action,
    confidence: result.confidence ?? null,
    details: result.details ?? {},
    error_message: result.status === "error" ? String(result.details ?? "") : null,
    started_at: new Date(startedAt).toISOString(),
    completed_at: completedAt.toISOString(),
    duration_ms: completedAt.getTime() - startedAt,
  });
  if (error) throw error;
}

async function finishAutomationRun(
  runId: string,
  results: RunResult[],
  startedAt: number,
): Promise<void> {
  const completedAt = new Date();
  const errorCount = results.filter((result) => result.status === "error").length;
  const failedCount = results.filter((result) => result.status === "failed").length;
  const { error } = await supabase.from("automation_runs").update({
    status: errorCount === 0 ? "completed" : "partial",
    total_tasks: results.length,
    passed_count: results.filter((result) => result.status === "passed").length,
    failed_count: failedCount,
    skipped_count: results.filter((result) => result.status.startsWith("skipped"))
      .length,
    error_count: errorCount,
    completed_at: completedAt.toISOString(),
    duration_ms: completedAt.getTime() - startedAt,
  }).eq("id", runId);
  if (error) throw error;
}

async function failAutomationRun(
  runId: string,
  message: string,
  startedAt: number,
): Promise<void> {
  const completedAt = new Date();
  const { error } = await supabase.from("automation_runs").update({
    status: "error",
    error_count: 1,
    error_message: message,
    completed_at: completedAt.toISOString(),
    duration_ms: completedAt.getTime() - startedAt,
  }).eq("id", runId);
  if (error) throw error;
}

async function notify(
  config: SmtpConfig | null,
  subject: string,
  text: string,
): Promise<void> {
  if (!config) {
    console.warn(
      `Email not sent (SMTP is not configured): ${subject}\n${text}`,
    );
    return;
  }
  try {
    await sendAlertEmail(config, subject, text);
  } catch (error) {
    console.error(
      `Email not sent (${subject}): ${errorMessage(error)}`,
    );
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error
    ? `${error.name}: ${error.message}`
    : String(error);
}

function safeEqual(left: string, right: string): boolean {
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  let difference = leftBytes.length ^ rightBytes.length;
  const length = Math.max(leftBytes.length, rightBytes.length);
  for (let index = 0; index < length; index++) {
    difference |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }
  return difference === 0;
}
