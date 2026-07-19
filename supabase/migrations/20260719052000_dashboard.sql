create table if not exists public.automation_runs (
  id uuid primary key default gen_random_uuid(),
  trigger text not null check (trigger in ('cron', 'manual')),
  dry_run boolean not null default false,
  requested_task_gid text,
  requested_by text,
  status text not null default 'running'
    check (status in ('running', 'completed', 'partial', 'error')),
  total_tasks integer not null default 0,
  passed_count integer not null default 0,
  failed_count integer not null default 0,
  skipped_count integer not null default 0,
  error_count integer not null default 0,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  duration_ms integer,
  error_message text
);

create table if not exists public.automation_run_items (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.automation_runs(id) on delete cascade,
  task_gid text not null,
  task_name text,
  parent_task_gid text,
  store_slug text,
  theme_id text,
  published_theme_id text,
  status text not null,
  action_taken text not null default 'none',
  confidence double precision check (
    confidence is null or confidence between 0 and 1
  ),
  details jsonb not null default '{}'::jsonb,
  error_message text,
  started_at timestamptz not null default now(),
  completed_at timestamptz not null default now(),
  duration_ms integer not null default 0
);

create index if not exists automation_runs_started_at_idx
  on public.automation_runs (started_at desc);
create index if not exists automation_runs_status_idx
  on public.automation_runs (status);
create index if not exists automation_run_items_run_id_idx
  on public.automation_run_items (run_id);
create index if not exists automation_run_items_store_started_idx
  on public.automation_run_items (store_slug, started_at desc);
create index if not exists automation_run_items_status_idx
  on public.automation_run_items (status);

alter table public.automation_runs enable row level security;
alter table public.automation_run_items enable row level security;
revoke all on public.automation_runs from anon, authenticated;
revoke all on public.automation_run_items from anon, authenticated;
grant all on public.automation_runs to service_role;
grant all on public.automation_run_items to service_role;

create or replace function public.list_promo_qa_stores()
returns table (
  id uuid,
  store_slug text,
  shop_domain text,
  active boolean,
  has_token boolean,
  created_at timestamptz,
  updated_at timestamptz
)
language plpgsql
security definer
set search_path = public
stable
as $$
begin
  if auth.role() <> 'service_role' then
    raise exception 'service role required';
  end if;

  return query
  select
    s.id,
    s.store_slug,
    s.shop_domain,
    s.active,
    s.theme_access_token_ciphertext is not null,
    s.created_at,
    s.updated_at
  from public.stores s
  order by s.store_slug;
end;
$$;

create or replace function public.update_promo_qa_store(
  p_current_slug text,
  p_store_slug text,
  p_shop_domain text,
  p_active boolean
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.role() <> 'service_role' then
    raise exception 'service role required';
  end if;

  update public.stores
  set
    store_slug = lower(p_store_slug),
    shop_domain = lower(p_shop_domain),
    active = p_active,
    updated_at = now()
  where store_slug = lower(p_current_slug);

  if not found then
    raise exception 'store not found';
  end if;
end;
$$;

revoke all on function public.list_promo_qa_stores()
  from public, anon, authenticated;
revoke all on function public.update_promo_qa_store(text, text, text, boolean)
  from public, anon, authenticated;
grant execute on function public.list_promo_qa_stores() to service_role;
grant execute on function public.update_promo_qa_store(text, text, text, boolean)
  to service_role;

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
