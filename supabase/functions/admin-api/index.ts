import { createClient } from "npm:@supabase/supabase-js@2";

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
const adminApiSecret = requiredEnv("ADMIN_API_SECRET");
const runnerSecret = requiredEnv("QA_RUNNER_SECRET");
const encryptionKey = requiredEnv("STORE_TOKEN_ENCRYPTION_KEY");

Deno.serve(async (request) => {
  if (!safeEqual(request.headers.get("x-admin-api-secret") ?? "", adminApiSecret)) {
    return json({ error: "Unauthorized" }, 401);
  }

  try {
    const url = new URL(request.url);
    const path = url.pathname.replace(/^\/admin-api/, "") || "/";

    if (request.method === "GET" && path === "/overview") {
      return json(await getOverview());
    }
    if (request.method === "GET" && path === "/settings/automation") {
      return json(await getAutomationSettings());
    }
    if (request.method === "PATCH" && path === "/settings/automation") {
      return json(await setAutomationSettings(await request.json()));
    }
    if (request.method === "GET" && path === "/stores") {
      return json({ stores: await listStores() });
    }
    if (request.method === "POST" && path === "/stores") {
      return json(await createStore(await request.json()), 201);
    }
    if (request.method === "PATCH" && path.startsWith("/stores/")) {
      return json(
        await updateStore(
          decodeURIComponent(path.slice("/stores/".length)),
          await request.json(),
        ),
      );
    }
    if (request.method === "GET" && path === "/activity") {
      return json(await listActivity(url.searchParams));
    }
    if (request.method === "GET" && path.startsWith("/runs/")) {
      return json(await getRun(decodeURIComponent(path.slice("/runs/".length))));
    }
    if (request.method === "POST" && path === "/run") {
      return json(await invokeRunner(await request.json(), request));
    }

    return json({ error: "Not found" }, 404);
  } catch (error) {
    console.error(error);
    const message = error instanceof Error ? error.message : String(error);
    return json({ error: message }, 400);
  }
});

async function listStores() {
  const { data, error } = await supabase.rpc("list_promo_qa_stores");
  if (error) throw error;
  return data ?? [];
}

async function createStore(raw: unknown) {
  const body = validateStoreBody(raw, true);
  const { error } = await supabase.rpc("register_promo_qa_store", {
    p_store_slug: body.storeSlug,
    p_theme_access_token: body.token,
    p_encryption_key: encryptionKey,
    p_display_name: body.displayName,
  });
  if (error) throw error;
  return { ok: true, store: body.storeSlug, displayName: body.displayName };
}

async function updateStore(currentSlug: string, raw: unknown) {
  const body = validateStoreBody(raw, false);
  const { error } = await supabase.rpc("update_promo_qa_store", {
    p_current_slug: currentSlug,
    p_display_name: body.displayName,
    p_active: body.active,
  });
  if (error) throw error;

  if (body.token) {
    const { error: tokenError } = await supabase.rpc("register_promo_qa_store", {
      p_store_slug: currentSlug,
      p_theme_access_token: body.token,
      p_encryption_key: encryptionKey,
      p_display_name: body.displayName,
    });
    if (tokenError) throw tokenError;
    if (!body.active) {
      const { error: deactivateError } = await supabase.rpc(
        "update_promo_qa_store",
        {
          p_current_slug: currentSlug,
          p_display_name: body.displayName,
          p_active: false,
        },
      );
      if (deactivateError) throw deactivateError;
    }
  }
  return { ok: true, store: currentSlug, displayName: body.displayName };
}

async function getAutomationSettings() {
  const { data, error } = await supabase.rpc("get_promo_qa_automation_enabled");
  if (error) throw error;
  const { data: row, error: rowError } = await supabase
    .from("promo_qa_settings")
    .select("updated_at")
    .eq("key", "automation_enabled")
    .maybeSingle();
  if (rowError) throw rowError;
  return {
    enabled: Boolean(data),
    updatedAt: row?.updated_at ?? null,
  };
}

async function setAutomationSettings(raw: unknown) {
  if (!isObject(raw) || typeof raw.enabled !== "boolean") {
    throw new Error("Expected { enabled: boolean }");
  }
  const { data, error } = await supabase.rpc("set_promo_qa_automation_enabled", {
    p_enabled: raw.enabled,
  });
  if (error) throw error;
  return { enabled: raw.enabled, updatedAt: data };
}

async function getOverview() {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const [stores, latestResult, recentResult, automation] = await Promise.all([
    listStores(),
    supabase.from("automation_runs").select("*")
      .order("started_at", { ascending: false }).limit(1).maybeSingle(),
    supabase.from("automation_run_items").select("status").gte("started_at", since),
    getAutomationSettings(),
  ]);
  if (latestResult.error) throw latestResult.error;
  if (recentResult.error) throw recentResult.error;
  const recent = recentResult.data ?? [];
  const latest = latestResult.data;
  return {
    automation,
    stores: {
      total: stores.length,
      active: stores.filter((store: { active: boolean }) => store.active).length,
      configured: stores.filter((store: { has_token: boolean }) => store.has_token)
        .length,
    },
    lastRun: latest,
    nextRunAt: nextTenMinuteBoundary(),
    recent: {
      total: recent.length,
      passed: recent.filter((item) => item.status === "passed").length,
      failed: recent.filter((item) => item.status === "failed").length,
      errors: recent.filter((item) => item.status === "error").length,
      skipped: recent.filter((item) => item.status.startsWith("skipped")).length,
    },
    configuration: {
      scheduler: automation.enabled,
      smtp: Boolean(Deno.env.get("SMTP_HOST") && Deno.env.get("SMTP_USER")),
      asana: Boolean(Deno.env.get("ASANA_ACCESS_TOKEN")),
      anthropic: Boolean(Deno.env.get("ANTHROPIC_API_KEY")),
    },
  };
}

async function listActivity(params: URLSearchParams) {
  const page = Math.max(1, Number(params.get("page") ?? "1") || 1);
  const limit = Math.min(100, Math.max(1, Number(params.get("limit") ?? "25") || 25));
  const from = (page - 1) * limit;
  let query = supabase.from("automation_run_items").select(
    "*,automation_runs!inner(trigger,dry_run,requested_by,status,started_at)",
    { count: "exact" },
  );
  const status = params.get("status");
  const store = params.get("store");
  const trigger = params.get("trigger");
  if (status) query = query.eq("status", status);
  if (store) query = query.eq("store_slug", store);
  if (trigger) query = query.eq("automation_runs.trigger", trigger);
  if (params.get("from")) query = query.gte("started_at", params.get("from")!);
  if (params.get("to")) query = query.lte("started_at", params.get("to")!);
  const { data, error, count } = await query
    .order("started_at", { ascending: false })
    .range(from, from + limit - 1);
  if (error) throw error;
  return { items: data ?? [], total: count ?? 0, page, limit };
}

async function getRun(id: string) {
  const { data, error } = await supabase.from("automation_runs")
    .select("*,automation_run_items(*)").eq("id", id).single();
  if (error) throw error;
  return { run: data };
}

async function invokeRunner(raw: unknown, request: Request) {
  const body = isObject(raw) ? raw : {};
  const taskGid = parseTaskGid(String(body.taskGid ?? ""));
  if (!taskGid) throw new Error("Enter a valid Asana task URL or task GID");
  const dryRun = body.dryRun !== false;
  if (!dryRun && body.confirmLive !== true) {
    throw new Error("Live runs require explicit confirmation");
  }

  const response = await fetch(`${supabaseUrl}/functions/v1/qa-runner`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-qa-runner-secret": runnerSecret,
      "x-qa-trigger": "manual",
      "x-qa-requested-by": request.headers.get("x-admin-user") ?? "dashboard",
    },
    body: JSON.stringify({ taskGid, dryRun, force: true }),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? "QA runner failed");
  return result;
}

function validateStoreBody(raw: unknown, requireToken: boolean) {
  if (!isObject(raw)) throw new Error("Invalid store payload");
  const displayName = String(raw.displayName ?? "").trim();
  const adminUrl = String(raw.adminUrl ?? "").trim();
  const manualSlug = String(raw.storeSlug ?? "").trim().toLowerCase();
  const parsedSlug = parseShopifyAdminSlug(adminUrl);
  const storeSlug = parsedSlug ?? manualSlug;
  const token = String(raw.token ?? "").trim();

  if (!displayName) {
    throw new Error("Enter a client name for this store");
  }
  if (!/^[a-z0-9][a-z0-9-]*$/.test(storeSlug)) {
    throw new Error(
      "Paste a Shopify admin URL or enter the store handle from admin.shopify.com/store/{handle}",
    );
  }
  if ((requireToken || token) && !/^shptka_[A-Za-z0-9]+$/.test(token)) {
    throw new Error("Enter a valid Theme Access password beginning with shptka_");
  }
  return {
    displayName,
    storeSlug,
    token,
    active: raw.active !== false,
  };
}

function parseShopifyAdminSlug(value: string): string | null {
  const match = value.match(/admin\.shopify\.com\/store\/([a-z0-9-]+)/i);
  return match ? match[1].toLowerCase() : null;
}

function parseTaskGid(value: string): string | null {
  const direct = value.trim().match(/^\d{10,}$/)?.[0];
  if (direct) return direct;
  const matches = [...value.matchAll(/\/(\d{10,})(?:\/|$|\?)/g)];
  return matches.at(-1)?.[1] ?? null;
}

function nextTenMinuteBoundary(): string {
  const next = new Date();
  next.setUTCSeconds(0, 0);
  next.setUTCMinutes(Math.ceil((next.getUTCMinutes() + 0.01) / 10) * 10);
  return next.toISOString();
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
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
