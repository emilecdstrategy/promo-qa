const taskGid = process.argv[2];
if (!taskGid) {
  console.error("Usage: npm run qa:local -- <asana-task-gid>");
  process.exit(1);
}

const supabaseUrl = required("SUPABASE_URL").replace(/\/$/, "");
const functionUrl = process.env.SUPABASE_FUNCTION_URL ??
  `${supabaseUrl}/functions/v1/qa-runner`;
const runnerSecret = required("QA_RUNNER_SECRET");

const response = await fetch(functionUrl, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "x-qa-runner-secret": runnerSecret,
    "x-qa-trigger": "manual",
    "x-qa-requested-by": "local-cli",
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
