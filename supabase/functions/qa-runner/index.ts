import { createClient } from "npm:@supabase/supabase-js@2";
import { AnthropicClient } from "../_shared/ai.ts";
import { AsanaClient, isPromoQaTask } from "../_shared/asana.ts";
import {
  sendAlertEmail,
  type SmtpConfig,
  smtpConfigFromEnv,
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
const smtp = smtpConfigFromEnv((name) => Deno.env.get(name));

interface RunRequest {
  taskGid?: string;
  dryRun?: boolean;
  force?: boolean;
}

interface RunResult {
  taskGid: string;
  status: string;
  action: string;
  details?: unknown;
}

Deno.serve(async (request) => {
  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  try {
    const input = await request.json().catch(() => ({})) as RunRequest;
    const tasks = input.taskGid
      ? [await asana.getTask(input.taskGid)]
      : (await asana.listIncompleteTasks(EMIL_ASANA_GID, ASANA_WORKSPACE_GID))
        .filter(isPromoQaTask);

    const results: RunResult[] = [];
    for (const task of tasks) {
      try {
        results.push(await processTask(task, input));
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
        results.push({
          taskGid: task.gid,
          status: "error",
          action: "none",
          details: message,
        });
      }
    }

    return Response.json({
      ok: results.every((result) => result.status !== "error"),
      dryRun: Boolean(input.dryRun),
      processed: results.length,
      results,
    });
  } catch (error) {
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
      taskGid: task.gid,
      status: "skipped_unregistered",
      action: input.dryRun ? "none" : "emailed",
      details: message,
    };
  }

  if (!input.force && !input.dryRun && await alreadyProcessed(context.task)) {
    return { taskGid: task.gid, status: "skipped_unchanged", action: "none" };
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
      taskGid: task.gid,
      status: confidentlyPassed ? "passed" : "failed",
      action: "none",
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
      taskGid: task.gid,
      status: "passed",
      action: "completed",
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
    taskGid: task.gid,
    status: "failed",
    action: "commented",
    details: verdict,
  };
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
  status: "processing" | "passed" | "failed" | "skipped_unregistered" | "error";
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
  await sendAlertEmail(config, subject, text);
}

function errorMessage(error: unknown): string {
  return error instanceof Error
    ? `${error.name}: ${error.message}`
    : String(error);
}
