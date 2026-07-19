const taskGid = process.argv[2];
if (!taskGid) {
  console.error("Usage: npm run qa:local -- <asana-task-gid>");
  process.exit(1);
}

const supabaseUrl = required("SUPABASE_URL").replace(/\/$/, "");
const functionUrl = process.env.SUPABASE_FUNCTION_URL ??
  `${supabaseUrl}/functions/v1/qa-runner`;
const authorization = process.env.SUPABASE_ANON_KEY ??
  process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!authorization) {
  throw new Error("Set SUPABASE_ANON_KEY or SUPABASE_SERVICE_ROLE_KEY in .env.local");
}

const response = await fetch(functionUrl, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${authorization}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({ taskGid, dryRun: true, force: true }),
});
const payload = await response.json().catch(() => null);

console.log(JSON.stringify(payload, null, 2));
if (!response.ok || !payload?.ok) process.exitCode = 1;

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name} in .env.local`);
  return value;
}
