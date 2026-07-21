export type RunnerTrigger = "cron" | "manual" | "webhook";

export interface InvokeQaRunnerInput {
  supabaseUrl: string;
  runnerSecret: string;
  trigger: RunnerTrigger;
  requestedBy?: string;
  taskGid?: string;
  dryRun?: boolean;
  force?: boolean;
}

export interface InvokeQaRunnerResult {
  ok: boolean;
  runId?: string;
  processed?: number;
  results?: unknown[];
  error?: string;
}

export async function invokeQaRunner(
  input: InvokeQaRunnerInput,
): Promise<InvokeQaRunnerResult> {
  const response = await fetch(
    `${input.supabaseUrl.replace(/\/$/, "")}/functions/v1/qa-runner`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-qa-runner-secret": input.runnerSecret,
        "x-qa-trigger": input.trigger,
        "x-qa-requested-by": input.requestedBy ?? input.trigger,
      },
      body: JSON.stringify({
        taskGid: input.taskGid,
        dryRun: input.dryRun ?? false,
        force: input.force ?? false,
      }),
    },
  );

  const result = await response.json().catch(() => ({})) as InvokeQaRunnerResult;
  if (!response.ok) {
    throw new Error(result.error ?? `QA runner failed (${response.status})`);
  }
  return result;
}
