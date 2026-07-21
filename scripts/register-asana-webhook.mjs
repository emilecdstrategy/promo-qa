function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

const supabaseUrl = required("SUPABASE_URL").replace(/\/$/, "");
const serviceRoleKey = required("SUPABASE_SERVICE_ROLE_KEY");
const asanaToken = required("ASANA_ACCESS_TOKEN");
const workspaceGid = process.env.ASANA_WORKSPACE_GID ?? "1201007545370748";
const targetUrl = process.env.ASANA_WEBHOOK_TARGET_URL ??
  `${supabaseUrl}/functions/v1/asana-webhook`;

async function upsertSetting(key, value) {
  const response = await fetch(`${supabaseUrl}/rest/v1/promo_qa_settings?on_conflict=key`, {
    method: "POST",
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates",
    },
    body: JSON.stringify({
      key,
      value,
      updated_at: new Date().toISOString(),
    }),
  });
  if (!response.ok) {
    throw new Error(await response.text());
  }
}

const response = await fetch("https://app.asana.com/api/1.0/webhooks", {
  method: "POST",
  headers: {
    Authorization: `Bearer ${asanaToken}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    data: {
      resource: workspaceGid,
      target: targetUrl,
      filters: [
        { resource_type: "task", action: "changed" },
        { resource_type: "task", action: "added" },
        { resource_type: "story", action: "added" },
      ],
    },
  }),
});

const payload = await response.json().catch(() => null);
if (!response.ok) {
  console.error(payload);
  throw new Error(payload?.errors?.[0]?.message ?? `Webhook create failed (${response.status})`);
}

const secret = response.headers.get("X-Hook-Secret");
if (secret) {
  await upsertSetting("asana_webhook_secret", { secret });
}

await upsertSetting("asana_webhook_meta", {
  gid: payload.data.gid,
  target: targetUrl,
  workspace_gid: workspaceGid,
  active: payload.data.active,
});

console.log("Asana webhook registered.");
console.log(`Webhook gid: ${payload.data.gid}`);
console.log(`Target URL: ${targetUrl}`);
console.log(`Active: ${payload.data.active}`);
console.log(secret ? "Hook secret stored in promo_qa_settings." : "No hook secret returned; complete the Asana handshake by hitting the target URL.");
