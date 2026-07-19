create table if not exists public.promo_qa_settings (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);

insert into public.promo_qa_settings (key, value)
values ('automation_enabled', jsonb_build_object('enabled', true))
on conflict (key) do nothing;

alter table public.promo_qa_settings enable row level security;
revoke all on public.promo_qa_settings from anon, authenticated;
grant all on public.promo_qa_settings to service_role;

create or replace function public.get_promo_qa_automation_enabled()
returns boolean
language plpgsql
security definer
set search_path = public
stable
as $$
declare
  v_enabled boolean;
begin
  if auth.role() <> 'service_role' then
    raise exception 'service role required';
  end if;

  select coalesce((value->>'enabled')::boolean, true)
  into v_enabled
  from public.promo_qa_settings
  where key = 'automation_enabled';

  return coalesce(v_enabled, true);
end;
$$;

create or replace function public.set_promo_qa_automation_enabled(p_enabled boolean)
returns timestamptz
language plpgsql
security definer
set search_path = public
as $$
declare
  v_updated_at timestamptz;
begin
  if auth.role() <> 'service_role' then
    raise exception 'service role required';
  end if;

  insert into public.promo_qa_settings (key, value, updated_at)
  values ('automation_enabled', jsonb_build_object('enabled', p_enabled), now())
  on conflict (key) do update
  set
    value = jsonb_build_object('enabled', p_enabled),
    updated_at = now()
  returning updated_at into v_updated_at;

  return v_updated_at;
end;
$$;

revoke all on function public.get_promo_qa_automation_enabled()
  from public, anon, authenticated;
revoke all on function public.set_promo_qa_automation_enabled(boolean)
  from public, anon, authenticated;
grant execute on function public.get_promo_qa_automation_enabled() to service_role;
grant execute on function public.set_promo_qa_automation_enabled(boolean) to service_role;

create or replace function public.invoke_promo_qa_runner()
returns bigint
language plpgsql
security definer
set search_path = public, vault, net
as $$
declare
  v_project_url text;
  v_runner_secret text;
  v_request_id bigint;
begin
  if not public.get_promo_qa_automation_enabled() then
    raise warning 'Promo QA cron skipped: automation is turned off';
    return null;
  end if;

  select decrypted_secret into v_project_url
  from vault.decrypted_secrets
  where name = 'promo_qa_project_url'
  limit 1;

  select decrypted_secret into v_runner_secret
  from vault.decrypted_secrets
  where name = 'promo_qa_runner_secret'
  limit 1;

  if v_project_url is null or v_runner_secret is null then
    raise warning 'Promo QA cron skipped: required Vault secrets are missing';
    return null;
  end if;

  select net.http_post(
    url := rtrim(v_project_url, '/') || '/functions/v1/qa-runner',
    headers := jsonb_build_object(
      'x-qa-runner-secret', v_runner_secret,
      'x-qa-trigger', 'cron',
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 120000
  ) into v_request_id;

  return v_request_id;
end;
$$;
