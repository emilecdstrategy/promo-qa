alter table public.stores
  add column if not exists display_name text;

update public.stores
set display_name = initcap(replace(store_slug, '-', ' '))
where display_name is null or btrim(display_name) = '';

alter table public.stores
  alter column display_name set default '',
  alter column display_name set not null;

drop function if exists public.register_promo_qa_store(text, text, text, text);
drop function if exists public.update_promo_qa_store(text, text, text, boolean);
drop function if exists public.list_promo_qa_stores();

create or replace function public.register_promo_qa_store(
  p_store_slug text,
  p_theme_access_token text,
  p_encryption_key text,
  p_display_name text default null,
  p_shop_domain text default null
)
returns uuid
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_id uuid;
  v_slug text;
  v_domain text;
  v_display_name text;
begin
  if auth.role() <> 'service_role' then
    raise exception 'service role required';
  end if;

  if p_theme_access_token !~ '^shptka_' then
    raise exception 'invalid Theme Access token';
  end if;

  v_slug := lower(btrim(p_store_slug));
  v_domain := lower(coalesce(nullif(btrim(p_shop_domain), ''), v_slug || '.myshopify.com'));
  v_display_name := btrim(coalesce(nullif(btrim(p_display_name), ''), initcap(replace(v_slug, '-', ' '))));

  insert into public.stores (
    store_slug,
    shop_domain,
    display_name,
    theme_access_token_ciphertext,
    active,
    updated_at
  )
  values (
    v_slug,
    v_domain,
    v_display_name,
    extensions.pgp_sym_encrypt(p_theme_access_token, p_encryption_key),
    true,
    now()
  )
  on conflict (store_slug) do update
  set
    shop_domain = excluded.shop_domain,
    display_name = excluded.display_name,
    theme_access_token_ciphertext = excluded.theme_access_token_ciphertext,
    active = true,
    updated_at = now()
  returning id into v_id;

  return v_id;
end;
$$;

create or replace function public.list_promo_qa_stores()
returns table (
  id uuid,
  store_slug text,
  shop_domain text,
  display_name text,
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
    s.display_name,
    s.active,
    s.theme_access_token_ciphertext is not null,
    s.created_at,
    s.updated_at
  from public.stores s
  order by lower(s.display_name), s.store_slug;
end;
$$;

create or replace function public.update_promo_qa_store(
  p_current_slug text,
  p_display_name text,
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

  if btrim(p_display_name) = '' then
    raise exception 'display name is required';
  end if;

  update public.stores
  set
    display_name = btrim(p_display_name),
    active = p_active,
    updated_at = now()
  where store_slug = lower(p_current_slug);

  if not found then
    raise exception 'store not found';
  end if;
end;
$$;

revoke all on function public.register_promo_qa_store(text, text, text, text, text)
  from public, anon, authenticated;
revoke all on function public.update_promo_qa_store(text, text, boolean)
  from public, anon, authenticated;
grant execute on function public.register_promo_qa_store(text, text, text, text, text)
  to service_role;
grant execute on function public.update_promo_qa_store(text, text, boolean)
  to service_role;

revoke all on function public.list_promo_qa_stores()
  from public, anon, authenticated;
grant execute on function public.list_promo_qa_stores() to service_role;

update public.stores
set display_name = 'Power Planter'
where store_slug = 'power-planter-augers';
