create extension if not exists pgcrypto with schema extensions;

create table if not exists public.stores (
  id uuid primary key default gen_random_uuid(),
  store_slug text not null unique,
  shop_domain text not null unique,
  theme_access_token_ciphertext bytea,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint stores_slug_format check (store_slug ~ '^[a-z0-9][a-z0-9-]*$'),
  constraint stores_domain_format check (shop_domain ~ '^[a-z0-9][a-z0-9-]*\.myshopify\.com$')
);

create table if not exists public.qa_runs (
  id uuid primary key default gen_random_uuid(),
  asana_task_gid text not null unique,
  parent_task_gid text,
  source_modified_at timestamptz,
  store_slug text,
  theme_id text,
  status text not null check (
    status in ('processing', 'passed', 'failed', 'skipped_unregistered', 'error')
  ),
  verdict_json jsonb not null default '{}'::jsonb,
  confidence double precision check (confidence is null or confidence between 0 and 1),
  action_taken text check (
    action_taken is null or action_taken in ('completed', 'commented', 'emailed', 'none')
  ),
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists qa_runs_status_idx on public.qa_runs (status);
create index if not exists qa_runs_updated_at_idx on public.qa_runs (updated_at desc);

alter table public.stores enable row level security;
alter table public.qa_runs enable row level security;

revoke all on public.stores from anon, authenticated;
revoke all on public.qa_runs from anon, authenticated;
grant all on public.stores to service_role;
grant all on public.qa_runs to service_role;

create or replace function public.register_promo_qa_store(
  p_store_slug text,
  p_shop_domain text,
  p_theme_access_token text,
  p_encryption_key text
)
returns uuid
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_id uuid;
begin
  if auth.role() <> 'service_role' then
    raise exception 'service role required';
  end if;

  if p_theme_access_token !~ '^shptka_' then
    raise exception 'invalid Theme Access token';
  end if;

  insert into public.stores (
    store_slug,
    shop_domain,
    theme_access_token_ciphertext,
    active,
    updated_at
  )
  values (
    lower(p_store_slug),
    lower(p_shop_domain),
    extensions.pgp_sym_encrypt(p_theme_access_token, p_encryption_key),
    true,
    now()
  )
  on conflict (store_slug) do update
  set
    shop_domain = excluded.shop_domain,
    theme_access_token_ciphertext = excluded.theme_access_token_ciphertext,
    active = true,
    updated_at = now()
  returning id into v_id;

  return v_id;
end;
$$;

create or replace function public.get_promo_qa_store(
  p_store_slug text,
  p_encryption_key text
)
returns table (
  id uuid,
  store_slug text,
  shop_domain text,
  theme_access_token text,
  active boolean
)
language plpgsql
security definer
set search_path = public, extensions
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
    extensions.pgp_sym_decrypt(s.theme_access_token_ciphertext, p_encryption_key),
    s.active
  from public.stores s
  where s.store_slug = lower(p_store_slug)
    and s.active
    and s.theme_access_token_ciphertext is not null;
end;
$$;

revoke all on function public.register_promo_qa_store(text, text, text, text)
  from public, anon, authenticated;
revoke all on function public.get_promo_qa_store(text, text)
  from public, anon, authenticated;
grant execute on function public.register_promo_qa_store(text, text, text, text)
  to service_role;
grant execute on function public.get_promo_qa_store(text, text)
  to service_role;

insert into public.stores (store_slug, shop_domain, active)
values ('power-planter-augers', 'power-planter-augers.myshopify.com', true)
on conflict (store_slug) do update
set shop_domain = excluded.shop_domain, active = true, updated_at = now();
