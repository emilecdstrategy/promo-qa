import { createClient } from "npm:@supabase/supabase-js@2";
import { AnthropicClient } from "../_shared/ai.ts";
import { AsanaClient, getMissingLinkRecipient, isPromoQaTask, isDueWithinDays, stripHtml } from "../_shared/asana.ts";
import {
  sendAlertEmail,
  type SmtpConfig,
  getSmtpConfig,
} from "../_shared/email.ts";
import { getIndexJson, getPublishedThemeId } from "../_shared/shopify.ts";
import type {
  AsanaTask,
  CommentIntent,
  IncomingComment,
  PromoDesignContext,
  StoreCredential,
  TaskContext,
} from "../_shared/types.ts";
import {
  alreadyRepliedToComment,
  pickIncomingComment,
  shouldListenToComment,
} from "../_shared/comment-agent.ts";
import {
  applyDeterministicGuards,
  collectBannerBlocks,
  formatFailureComment,
  matchExpectedBanners,
} from "../_shared/verify.ts";
import {
  type RegisteredStore,
  resolveStoreSlug,
} from "../_shared/store-resolve.ts";

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
  "Hey — this one's due soon but I don't see a Shopify theme editor / promo scheduler link in the notes yet. Drop it in when it's ready to schedule?";
const MISSING_LINK_COMMENT_FINGERPRINT =
  "promo scheduler link in the task notes yet";
const MISSING_LINK_FOLLOWUP_COMMENT =
  "Got it that this is ready for QA — I still need the Shopify theme editor / promo scheduler link in this task's notes though. Can you paste it here?";
const MISSING_LINK_FOLLOWUP_FINGERPRINT =
  "still need the shopify theme editor / promo scheduler link";
const READY_FOR_QA_COMMENT =
  /\b(?:ready for qa|set for your qa|set for qa|rfr|this is uploaded|uploaded!|upload complete|ready for review)\b/i;
const UNREGISTERED_STORE_COMMENT_FINGERPRINT =
  "theme access is not configured yet for";
const FAILURE_COMMENT_FINGERPRINT =
  "automated promo qa found configuration issues";

let registeredStoresCache: RegisteredStore[] | null = null;

interface RunRequest {
  taskGid?: string;
  storyGid?: string;
  dryRun?: boolean;
  force?: boolean;
}

interface ConversationContext {
  incoming: IncomingComment;
  intent: CommentIntent;
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
  registeredStoresCache = null;
  try {
    const input = await request.json().catch(() => ({})) as RunRequest;
    const triggerHeader = request.headers.get("x-qa-trigger") ?? "manual";
    const trigger = triggerHeader === "cron"
      ? "cron"
      : triggerHeader === "webhook"
      ? "webhook"
      : "manual";

    if ((trigger === "cron" || trigger === "webhook") && !await isAutomationEnabled()) {
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
  const stores = await listRegisteredStores();
  const storeResolution = await resolveStoreSlug(context, stores, anthropic);
  const resultMeta = {
    taskGid: task.gid,
    taskName: context.task.name,
    parentTaskGid: context.parent?.gid ?? context.task.parent?.gid,
    storeSlug: context.editorTarget?.storeSlug ?? storeResolution.store_slug ?? undefined,
    themeId: context.editorTarget?.themeId,
  };
  const storeRegistered = Boolean(
    context.editorTarget &&
      stores.some((store) => store.store_slug === context.editorTarget?.storeSlug),
  );
  const conversation = await resolveConversation(
    context,
    input,
    storeRegistered,
  );
  if (conversation?.intent.forceQa) {
    input = { ...input, force: true };
  }

  if (
    conversation &&
    conversation.intent.replyNeeded &&
    !conversation.intent.runQa &&
    !input.force
  ) {
    await replyToIncoming(context, conversation, {
      outcome: "reply",
      outcomeSummary: conversation.intent.reply ?? "Noted.",
      storeRegistered,
    });
    return {
      ...resultMeta,
      status: "replied",
      action: "commented",
      details: conversation.intent,
    };
  }

  if (!context.editorTarget) {
    return handleMissingEditorUrl(
      context,
      input,
      resultMeta,
      storeResolution,
      conversation,
    );
  }

  const store = await getStore(context.editorTarget.storeSlug);

  if (!store) {
    return handleUnregisteredStore(context, input, resultMeta, conversation);
  }

  if (!input.force && !input.dryRun && await alreadyProcessed(context.task)) {
    if (conversation?.intent.replyNeeded) {
      const previous = await getPreviousQaSummary(task.gid);
      await replyToIncoming(context, conversation, {
        outcome: previous?.status ?? "skipped_unchanged",
        outcomeSummary: previous?.summary ??
          "Nothing new to check yet — the task notes have not changed since the last QA run.",
        storeRegistered: true,
      });
      return {
        ...resultMeta,
        status: "skipped_unchanged",
        action: "commented",
        details: conversation.intent,
      };
    }
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
    if (conversation?.intent.replyNeeded) {
      await replyToIncoming(context, conversation, {
        outcome: "passed",
        outcomeSummary: verdict.summary,
        storeRegistered: true,
      });
    }
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

  const repliedToHuman = conversation?.intent.replyNeeded
    ? await replyToIncoming(context, conversation, {
      outcome: "failed",
      outcomeSummary: verdict.summary,
      issues: verdict.banners.flatMap((banner) => banner.issues ?? []),
      storeRegistered: true,
    })
    : false;
  const shouldComment = !input.dryRun && !repliedToHuman &&
    (input.force || !await failureCommentAlreadySent(task.gid, verdict));
  if (shouldComment) {
    await recordRun({
      context,
      task: context.task,
      status: "failed",
      action: "commented",
      verdict: { spec, verdict, publishedThemeId, commentPending: true },
      confidence: Math.min(spec.confidence, verdict.confidence),
    });
    await asana.addQaComment(
      task.gid,
      context.creator,
      formatFailureComment(verdict),
      FAILURE_COMMENT_FINGERPRINT,
    );
  }

  const refreshedTask = shouldComment || repliedToHuman
    ? await asana.getTask(task.gid)
    : context.task;
  await recordRun({
    context,
    task: refreshedTask,
    status: "failed",
    action: (shouldComment || repliedToHuman) ? "commented" : "none",
    verdict: { spec, verdict, publishedThemeId },
    confidence: Math.min(spec.confidence, verdict.confidence),
  });
  return {
    ...resultMeta,
    publishedThemeId,
    status: "failed",
    action: (shouldComment || repliedToHuman) ? "commented" : "none",
    confidence: Math.min(spec.confidence, verdict.confidence),
    details: verdict,
  };
}

function unregisteredStoreMessage(
  shopDomain: string,
  task: AsanaTask,
): string {
  return `Theme Access is not configured for ${shopDomain}.\n` +
    `Asana task: ${task.name} (${task.gid})`;
}

function unregisteredStoreComment(shopDomain: string): string {
  return `Found the editor link, but Theme Access is not configured yet for ${shopDomain} so I can't inspect the theme. Once that store is added in Promo QA I'll pick this up on the next run.`;
}

async function handleUnregisteredStore(
  context: TaskContext,
  input: RunRequest,
  resultMeta: Pick<
    RunResult,
    "taskGid" | "taskName" | "parentTaskGid" | "storeSlug" | "themeId"
  >,
  conversation: ConversationContext | null,
): Promise<RunResult> {
  const shopDomain = context.editorTarget!.shopDomain;
  const message = unregisteredStoreMessage(shopDomain, context.task);

  if (
    conversation?.intent.replyNeeded &&
    await replyToIncoming(context, conversation, {
      outcome: "skipped_unregistered",
      outcomeSummary: message,
      storeRegistered: false,
    })
  ) {
    if (!input.dryRun) {
      await recordRun({
        context,
        task: context.task,
        status: "skipped_unregistered",
        action: "commented",
        verdict: { reason: message },
      });
    }
    return {
      ...resultMeta,
      status: "skipped_unregistered",
      action: "commented",
      details: message,
    };
  }

  if (!input.dryRun && !input.force &&
    await unregisteredStoreAlreadyHandled(context.task)) {
    return {
      ...resultMeta,
      status: "skipped_unregistered",
      action: "none",
      details: message,
    };
  }

  const designContext = await asana.getPromoDesignContext(context.parent);
  const recipient = getMissingLinkRecipient(designContext, context.creator);
  const shouldComment = !input.dryRun &&
    !await asana.hasCommentContaining(
      context.task.gid,
      UNREGISTERED_STORE_COMMENT_FINGERPRINT,
    );
  const shouldEmail = !input.dryRun;

  if (shouldComment) {
    await asana.addQaComment(
      context.task.gid,
      recipient,
      unregisteredStoreComment(shopDomain),
      UNREGISTERED_STORE_COMMENT_FINGERPRINT,
    );
  }
  if (shouldEmail) {
    await notify(
      smtp,
      `Promo QA store needs setup: ${context.editorTarget!.storeSlug}`,
      message,
    );
  }
  if (!input.dryRun) {
    await recordRun({
      context,
      task: context.task,
      status: "skipped_unregistered",
      action: shouldComment ? "commented" : shouldEmail ? "emailed" : "none",
      verdict: { reason: message },
    });
  }

  return {
    ...resultMeta,
    status: "skipped_unregistered",
    action: input.dryRun
      ? "none"
      : shouldComment
      ? "commented"
      : shouldEmail
      ? "emailed"
      : "none",
    details: message,
  };
}

async function unregisteredStoreAlreadyHandled(
  task: AsanaTask,
): Promise<boolean> {
  const { data, error } = await supabase
    .from("qa_runs")
    .select("status,source_modified_at,action_taken")
    .eq("asana_task_gid", task.gid)
    .maybeSingle();
  if (error) throw error;
  if (data?.status !== "skipped_unregistered") return false;
  if (!task.modified_at || !data.source_modified_at) return true;
  return new Date(data.source_modified_at).getTime() >=
    new Date(task.modified_at).getTime();
}

async function resolveConversation(
  context: TaskContext,
  input: RunRequest,
  storeRegistered: boolean,
): Promise<ConversationContext | null> {
  if (input.dryRun) return null;

  const [qaComments, parentComments, preferredStory] = await Promise.all([
    asana.listTaskComments(context.task.gid),
    context.parent?.gid
      ? asana.listTaskComments(context.parent.gid)
      : Promise.resolve([]),
    input.storyGid ? asana.getStory(input.storyGid) : Promise.resolve(null),
  ]);
  const comments = [...parentComments, ...qaComments];
  let incoming = pickIncomingComment(
    comments,
    input.storyGid,
    EMIL_ASANA_GID,
    context.task.gid,
  );
  if (
    preferredStory &&
    shouldListenToComment(preferredStory, EMIL_ASANA_GID, {
      onQaTask: preferredStory.taskGid === context.task.gid,
    })
  ) {
    incoming = preferredStory;
  }
  if (!incoming) return null;
  if (alreadyRepliedToComment(incoming, comments, EMIL_ASANA_GID)) {
    return null;
  }

  const previous = await getPreviousQaSummary(context.task.gid);
  const intent = await anthropic.interpretTaskComment({
    incoming,
    recentComments: comments.slice(-8).map((comment) => ({
      author: comment.authorName,
      text: comment.text,
      createdAt: comment.createdAt,
    })),
    qaTaskName: context.task.name,
    parentName: context.parent?.name,
    hasEditorLink: Boolean(context.editorTarget),
    storeRegistered,
    lastQaStatus: previous?.status ?? null,
    lastQaSummary: previous?.summary ?? null,
  });

  if (
    intent.action === "ignore" &&
    !intent.replyNeeded &&
    !intent.runQa &&
    !intent.forceQa
  ) {
    return null;
  }

  return { incoming, intent };
}

async function replyToIncoming(
  context: TaskContext,
  conversation: ConversationContext,
  outcome: {
    outcome: string;
    outcomeSummary: string;
    issues?: string[];
    storeRegistered?: boolean;
  },
): Promise<boolean> {
  const recipient = conversation.incoming.authorGid &&
      conversation.incoming.authorName
    ? {
      gid: conversation.incoming.authorGid,
      name: conversation.incoming.authorName,
    }
    : context.creator;

  let message = conversation.intent.reply ?? outcome.outcomeSummary;
  try {
    message = await anthropic.composeQaReply({
      incoming: conversation.incoming,
      draftReply: conversation.intent.reply,
      qaTaskName: context.task.name,
      parentName: context.parent?.name,
      outcome: outcome.outcome,
      outcomeSummary: outcome.outcomeSummary,
      issues: outcome.issues,
      hasEditorLink: Boolean(context.editorTarget),
      storeRegistered: outcome.storeRegistered ?? Boolean(context.editorTarget),
    });
  } catch (error) {
    console.error("Failed to compose conversational QA reply:", error);
  }
  if (!message.trim()) return false;

  await asana.addQaComment(conversation.incoming.taskGid, recipient, message);
  return true;
}

async function getPreviousQaSummary(
  taskGid: string,
): Promise<{ status: string; summary: string } | null> {
  const { data, error } = await supabase
    .from("qa_runs")
    .select("status,verdict_json")
    .eq("asana_task_gid", taskGid)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;

  const verdictJson = data.verdict_json as {
    reason?: string;
    verdict?: { summary?: string };
    summary?: string;
  } | null;
  const summary = verdictJson?.verdict?.summary ??
    verdictJson?.summary ??
    verdictJson?.reason ??
    data.status;
  return { status: data.status, summary };
}

async function handleMissingEditorUrl(
  context: TaskContext,
  input: RunRequest,
  resultMeta: Pick<
    RunResult,
    "taskGid" | "taskName" | "parentTaskGid" | "storeSlug" | "themeId"
  >,
  storeResolution: Awaited<ReturnType<typeof resolveStoreSlug>>,
  conversation: ConversationContext | null,
): Promise<RunResult> {
  const waitingMessage =
    "Waiting for a Shopify theme editor / promo scheduler link in the task notes.";
  const dueSoon = isDueWithinDays(context.task, MISSING_LINK_DUE_WINDOW_DAYS);

  if (conversation?.intent.replyNeeded) {
    await replyToIncoming(context, conversation, {
      outcome: "skipped_not_ready",
      outcomeSummary: waitingMessage,
      storeRegistered: Boolean(storeResolution.store_slug),
    });
    return {
      ...resultMeta,
      status: "skipped_not_ready",
      action: "commented",
      details: { reason: waitingMessage, storeResolution, conversation: conversation.intent },
    };
  }

  if (!dueSoon) {
    return {
      ...resultMeta,
      status: "skipped_not_ready",
      action: "none",
      details: { reason: waitingMessage, storeResolution },
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
        storeResolution,
      },
    };
  }

  const reminder = await resolveMissingLinkReminder(context.task.gid, designContext);
  const recipient = getMissingLinkRecipient(designContext, context.creator);
  const shouldComment = !input.dryRun && (input.force || reminder.shouldSend);

  if (shouldComment) {
    await recordRun({
      context,
      task: context.task,
      status: "skipped_not_ready",
      action: "commented",
      verdict: {
        reason: waitingMessage,
        dueSoon: true,
        designAssessment,
        commentPending: true,
        reminderKind: reminder.fingerprint === MISSING_LINK_FOLLOWUP_FINGERPRINT
          ? "followup"
          : "initial",
      },
    });
    await asana.addQaComment(
      context.task.gid,
      recipient,
      reminder.message,
      reminder.fingerprint,
    );
    await recordRun({
      context,
      task: await asana.getTask(context.task.gid),
      status: "skipped_not_ready",
      action: "commented",
      verdict: {
        reason: waitingMessage,
        dueSoon: true,
        designAssessment,
        reminderSent: true,
        reminderKind: reminder.fingerprint === MISSING_LINK_FOLLOWUP_FINGERPRINT
          ? "followup"
          : "initial",
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
      storeResolution,
      notifiedCreator: shouldComment,
      notifiedRecipient: shouldComment ? recipient?.name ?? null : null,
      reminderKind: shouldComment
        ? (reminder.fingerprint === MISSING_LINK_FOLLOWUP_FINGERPRINT
          ? "followup"
          : "initial")
        : null,
    },
  };
}

async function resolveMissingLinkReminder(
  taskGid: string,
  designContext: PromoDesignContext,
): Promise<{ shouldSend: boolean; message: string; fingerprint: string }> {
  const initial = {
    message: MISSING_LINK_COMMENT,
    fingerprint: MISSING_LINK_COMMENT_FINGERPRINT,
  };
  const followUp = {
    message: MISSING_LINK_FOLLOWUP_COMMENT,
    fingerprint: MISSING_LINK_FOLLOWUP_FINGERPRINT,
  };

  const [initialComment, followUpComment] = await Promise.all([
    asana.getLatestCommentContaining(taskGid, initial.fingerprint),
    asana.getLatestCommentContaining(taskGid, followUp.fingerprint),
  ]);

  if (!initialComment) {
    const { data, error } = await supabase
      .from("qa_runs")
      .select("status,action_taken")
      .eq("asana_task_gid", taskGid)
      .maybeSingle();
    if (error) throw error;
    if (data?.status === "skipped_not_ready" && data.action_taken === "commented") {
      return { shouldSend: false, ...initial };
    }
    return { shouldSend: true, ...initial };
  }

  if (followUpComment) {
    return { shouldSend: false, ...followUp };
  }

  const lastReminderAt = initialComment.created_at;
  const readySignalAfterReminder = designContext.comments.some((comment) =>
    comment.created_at &&
    comment.created_at.localeCompare(lastReminderAt) > 0 &&
    READY_FOR_QA_COMMENT.test(comment.text)
  );

  if (readySignalAfterReminder) {
    return { shouldSend: true, ...followUp };
  }

  return { shouldSend: false, ...followUp };
}

async function listRegisteredStores(): Promise<RegisteredStore[]> {
  if (registeredStoresCache) return registeredStoresCache;
  const { data, error } = await supabase.rpc("list_promo_qa_stores");
  if (error) throw error;
  registeredStoresCache = (data ?? []).map((store: {
    store_slug: string;
    shop_domain: string;
    display_name?: string | null;
  }) => ({
    store_slug: store.store_slug,
    shop_domain: store.shop_domain,
    display_name: store.display_name ?? null,
  }));
  return registeredStoresCache;
}

async function failureCommentAlreadySent(
  taskGid: string,
  verdict: Awaited<ReturnType<typeof applyDeterministicGuards>>,
): Promise<boolean> {
  if (await asana.hasCommentContaining(taskGid, FAILURE_COMMENT_FINGERPRINT)) {
    return true;
  }

  const signature = failureSignature(verdict);
  const { data, error } = await supabase
    .from("qa_runs")
    .select("status,action_taken,verdict_json")
    .eq("asana_task_gid", taskGid)
    .maybeSingle();
  if (error) throw error;
  if (data?.status !== "failed" || data.action_taken !== "commented") {
    return false;
  }

  return failureSignatureFromStoredVerdict(data.verdict_json) === signature;
}

function failureSignature(
  verdict: Awaited<ReturnType<typeof applyDeterministicGuards>>,
): string {
  return verdict.banners
    .flatMap((banner) => banner.issues ?? [])
    .map((issue) => issue.trim().toLowerCase())
    .filter(Boolean)
    .sort()
    .join("|");
}

function failureSignatureFromStoredVerdict(verdictJson: unknown): string {
  if (!verdictJson || typeof verdictJson !== "object") return "";

  const verdict = (verdictJson as {
    verdict?: { banners?: Array<{ issues?: string[] }> };
  }).verdict;
  return (verdict?.banners ?? [])
    .flatMap((banner) => banner.issues ?? [])
    .map((issue) => issue.trim().toLowerCase())
    .filter(Boolean)
    .sort()
    .join("|");
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
    store_slug: input.context?.editorTarget?.storeSlug ?? null,
    theme_id: input.context?.editorTarget?.themeId ?? null,
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
  trigger: "cron" | "manual" | "webhook";
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
