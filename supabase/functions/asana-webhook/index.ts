import { createClient } from "npm:@supabase/supabase-js@2";
import {
  AsanaClient,
  isPromoQaTask,
  verifyAsanaWebhookSignature,
} from "../_shared/asana.ts";
import { invokeQaRunner } from "../_shared/runner.ts";
import type { AsanaWebhookEvent, AsanaWebhookPayload } from "../_shared/types.ts";

const requiredEnv = (name: string): string => {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
};

const supabaseUrl = requiredEnv("SUPABASE_URL").replace(/\/$/, "");
const supabase = createClient(
  supabaseUrl,
  requiredEnv("SUPABASE_SERVICE_ROLE_KEY"),
  { auth: { persistSession: false, autoRefreshToken: false } },
);
const asana = new AsanaClient(requiredEnv("ASANA_ACCESS_TOKEN"));
const runnerSecret = requiredEnv("QA_RUNNER_SECRET");
const assigneeGid = Deno.env.get("ASANA_ASSIGNEE_GID") ?? "1206406200377321";
const debounceMs = Number(Deno.env.get("WEBHOOK_DEBOUNCE_MS") ?? "60000");

Deno.serve(async (request) => {
  if (request.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const rawBody = await request.text();
  const hookSecretHeader = request.headers.get("X-Hook-Secret");

  if (hookSecretHeader) {
    await storeWebhookSecret(hookSecretHeader);
    return new Response(null, {
      status: 200,
      headers: { "X-Hook-Secret": hookSecretHeader },
    });
  }

  try {
    const secret = await getWebhookSecret();
    if (!secret) {
      console.error("Asana webhook received before a hook secret was stored");
      return new Response("Webhook secret not configured", { status: 500 });
    }

    const signature = request.headers.get("X-Hook-Signature");
    if (!await verifyAsanaWebhookSignature(secret, rawBody, signature)) {
      return new Response("Invalid signature", { status: 401 });
    }

    if (!await isAutomationEnabled()) {
      return new Response(null, { status: 204 });
    }

    const payload = JSON.parse(rawBody || "{}") as AsanaWebhookPayload;
    const events = payload.events ?? [];
    if (!events.length) {
      return new Response(null, { status: 204 });
    }

    const taskGids = await resolvePromoQaTaskGids(events);
    const invoked: string[] = [];
    for (const taskGid of taskGids) {
      if (await isDebounced(taskGid)) continue;
      await markDebounced(taskGid);
      await invokeQaRunner({
        supabaseUrl,
        runnerSecret,
        trigger: "webhook",
        requestedBy: "asana-webhook",
        taskGid,
      });
      invoked.push(taskGid);
    }

    return Response.json({
      ok: true,
      events: events.length,
      invoked,
    });
  } catch (error) {
    console.error("Asana webhook handler failed:", error);
    return new Response(null, { status: 204 });
  }
});

async function resolvePromoQaTaskGids(
  events: AsanaWebhookEvent[],
): Promise<string[]> {
  const taskGids = new Set<string>();

  for (const event of events) {
    const taskGid = await resolveTaskGidFromEvent(event);
    if (!taskGid) continue;

    try {
      const task = await asana.getTask(taskGid);
      if (!task.completed && isPromoQaTask(task) && task.assignee?.gid === assigneeGid) {
        taskGids.add(task.gid);
      }

      const subtasks = await asana.listPromoQaSubtasksForParent(
        task.gid,
        assigneeGid,
      );
      for (const subtask of subtasks) {
        taskGids.add(subtask.gid);
      }
    } catch (error) {
      console.error(`Failed to resolve promo QA tasks for ${taskGid}:`, error);
    }
  }

  return [...taskGids];
}

async function resolveTaskGidFromEvent(
  event: AsanaWebhookEvent,
): Promise<string | null> {
  if (event.resource.resource_type === "task") {
    return event.resource.gid;
  }
  if (
    event.resource.resource_type === "story" &&
    event.parent?.resource_type === "task"
  ) {
    return event.parent.gid;
  }
  return null;
}

async function getWebhookSecret(): Promise<string | null> {
  const envSecret = Deno.env.get("ASANA_WEBHOOK_SECRET");
  if (envSecret) return envSecret;

  const { data, error } = await supabase
    .from("promo_qa_settings")
    .select("value")
    .eq("key", "asana_webhook_secret")
    .maybeSingle();
  if (error) throw error;
  const secret = data?.value?.secret;
  return typeof secret === "string" && secret.length > 0 ? secret : null;
}

async function storeWebhookSecret(secret: string): Promise<void> {
  const { error } = await supabase.from("promo_qa_settings").upsert({
    key: "asana_webhook_secret",
    value: { secret },
    updated_at: new Date().toISOString(),
  }, { onConflict: "key" });
  if (error) throw error;
}

async function isAutomationEnabled(): Promise<boolean> {
  const { data, error } = await supabase.rpc("get_promo_qa_automation_enabled");
  if (error) throw error;
  return Boolean(data);
}

async function isDebounced(taskGid: string): Promise<boolean> {
  const { data, error } = await supabase
    .from("webhook_task_debounce")
    .select("last_enqueued_at")
    .eq("task_gid", taskGid)
    .maybeSingle();
  if (error) throw error;
  if (!data?.last_enqueued_at) return false;
  return Date.now() - new Date(data.last_enqueued_at).getTime() < debounceMs;
}

async function markDebounced(taskGid: string): Promise<void> {
  const { error } = await supabase.from("webhook_task_debounce").upsert({
    task_gid: taskGid,
    last_enqueued_at: new Date().toISOString(),
  }, { onConflict: "task_gid" });
  if (error) throw error;
}
