alter table public.automation_runs drop constraint if exists automation_runs_trigger_check;

alter table public.automation_runs add constraint automation_runs_trigger_check
  check (trigger in ('cron', 'manual', 'webhook'));

create table if not exists public.webhook_task_debounce (
  task_gid text primary key,
  last_enqueued_at timestamptz not null default now()
);

alter table public.webhook_task_debounce enable row level security;
revoke all on public.webhook_task_debounce from anon, authenticated;
grant all on public.webhook_task_debounce to service_role;

do $$
declare
  v_job_id bigint;
begin
  for v_job_id in
    select jobid
    from cron.job
    where jobname in (
      'promo-qa-every-10-minutes',
      'promo-qa-every-20-minutes',
      'promo-qa-safety-net'
    )
  loop
    perform cron.unschedule(v_job_id);
  end loop;
end;
$$;

select cron.schedule(
  'promo-qa-safety-net',
  '0 */4 * * *',
  'select public.invoke_promo_qa_runner();'
);
