create extension if not exists pg_cron with schema extensions;
create extension if not exists pg_net with schema extensions;
create extension if not exists supabase_vault with schema vault;

create or replace function public.invoke_promo_qa_runner()
returns bigint
language plpgsql
security definer
set search_path = public, vault, net
as $$
declare
  v_project_url text;
  v_anon_key text;
  v_request_id bigint;
begin
  select decrypted_secret into v_project_url
  from vault.decrypted_secrets
  where name = 'promo_qa_project_url'
  limit 1;

  select decrypted_secret into v_anon_key
  from vault.decrypted_secrets
  where name = 'promo_qa_anon_key'
  limit 1;

  if v_project_url is null or v_anon_key is null then
    raise warning 'Promo QA cron skipped: add promo_qa_project_url and promo_qa_anon_key to Vault';
    return null;
  end if;

  select net.http_post(
    url := rtrim(v_project_url, '/') || '/functions/v1/qa-runner',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || v_anon_key,
      'apikey', v_anon_key,
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 120000
  ) into v_request_id;

  return v_request_id;
end;
$$;

revoke all on function public.invoke_promo_qa_runner() from public, anon, authenticated;
grant execute on function public.invoke_promo_qa_runner() to service_role;

do $$
declare
  v_job_id bigint;
begin
  select jobid into v_job_id
  from cron.job
  where jobname = 'promo-qa-every-10-minutes';

  if v_job_id is not null then
    perform cron.unschedule(v_job_id);
  end if;
end;
$$;

select cron.schedule(
  'promo-qa-every-10-minutes',
  '*/10 * * * *',
  'select public.invoke_promo_qa_runner();'
);
