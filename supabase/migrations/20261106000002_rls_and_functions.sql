-- Row Level Security + membership helpers + create_shop RPC.
-- Rule: every shop-owned table is readable only by active members of that shop;
-- writes are role-gated here in the database, not only in the UI.

-- ---------- helpers (SECURITY DEFINER avoids RLS recursion on shop_memberships) ----------
create function public.is_shop_member(p_shop uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.shop_memberships m
    where m.shop_id = p_shop and m.user_id = auth.uid() and m.status = 'active'
  );
$$;

create function public.has_shop_role(p_shop uuid, p_roles public.member_role[]) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.shop_memberships m
    where m.shop_id = p_shop and m.user_id = auth.uid() and m.status = 'active'
      and m.role = any (p_roles)
  );
$$;

create function public.product_shop_id(p_product uuid) returns uuid
language sql stable security definer set search_path = public as $$
  select shop_id from public.products where id = p_product;
$$;

create function public.variant_shop_id(p_variant uuid) returns uuid
language sql stable security definer set search_path = public as $$
  select shop_id from public.product_variants where id = p_variant;
$$;

create function public.session_shop_id(p_session uuid) returns uuid
language sql stable security definer set search_path = public as $$
  select shop_id from public.stock_count_sessions where id = p_session;
$$;

revoke execute on all functions in schema public from public, anon;
grant execute on function public.is_shop_member(uuid), public.has_shop_role(uuid, public.member_role[]),
  public.product_shop_id(uuid), public.variant_shop_id(uuid), public.session_shop_id(uuid)
  to authenticated;

-- ---------- enable RLS everywhere ----------
alter table public.shops enable row level security;
alter table public.user_profiles enable row level security;
alter table public.shop_memberships enable row level security;
alter table public.categories enable row level security;
alter table public.products enable row level security;
alter table public.product_variants enable row level security;
alter table public.packaging_units enable row level security;
alter table public.product_price_history enable row level security;
alter table public.stock_count_sessions enable row level security;
alter table public.stock_count_lines enable row level security;
alter table public.stock_movements enable row level security;
alter table public.daily_sales enable row level security;
alter table public.stock_count_corrections enable row level security;
alter table public.audit_logs enable row level security;

-- Anonymous users get nothing.
revoke all on all tables in schema public from anon;

-- ---------- shops ----------
create policy shops_select on public.shops for select to authenticated
  using (public.is_shop_member(id));
create policy shops_update on public.shops for update to authenticated
  using (public.has_shop_role(id, array['owner']::public.member_role[]))
  with check (public.has_shop_role(id, array['owner']::public.member_role[]));
-- No direct INSERT: shops are created through create_shop().

-- ---------- profiles ----------
create policy profiles_select on public.user_profiles for select to authenticated
  using (
    id = auth.uid() or exists (
      select 1 from public.shop_memberships a
      join public.shop_memberships b on a.shop_id = b.shop_id
      where a.user_id = auth.uid() and a.status = 'active' and b.user_id = user_profiles.id
    )
  );
create policy profiles_insert on public.user_profiles for insert to authenticated
  with check (id = auth.uid());
create policy profiles_update on public.user_profiles for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());

-- ---------- memberships (owner manages; members can see teammates) ----------
create policy memberships_select on public.shop_memberships for select to authenticated
  using (user_id = auth.uid() or public.is_shop_member(shop_id));
create policy memberships_insert on public.shop_memberships for insert to authenticated
  with check (public.has_shop_role(shop_id, array['owner']::public.member_role[]));
create policy memberships_update on public.shop_memberships for update to authenticated
  using (public.has_shop_role(shop_id, array['owner']::public.member_role[]))
  with check (public.has_shop_role(shop_id, array['owner']::public.member_role[]));
create policy memberships_delete on public.shop_memberships for delete to authenticated
  using (public.has_shop_role(shop_id, array['owner']::public.member_role[]));

-- ---------- catalog: members read, owner writes ----------
create policy categories_select on public.categories for select to authenticated
  using (public.is_shop_member(shop_id));
create policy categories_write on public.categories for all to authenticated
  using (public.has_shop_role(shop_id, array['owner']::public.member_role[]))
  with check (public.has_shop_role(shop_id, array['owner']::public.member_role[]));

create policy products_select on public.products for select to authenticated
  using (public.is_shop_member(shop_id));
create policy products_write on public.products for all to authenticated
  using (public.has_shop_role(shop_id, array['owner']::public.member_role[]))
  with check (public.has_shop_role(shop_id, array['owner']::public.member_role[]));

create policy variants_select on public.product_variants for select to authenticated
  using (public.is_shop_member(shop_id));
create policy variants_write on public.product_variants for all to authenticated
  using (public.has_shop_role(shop_id, array['owner']::public.member_role[]))
  with check (
    public.has_shop_role(shop_id, array['owner']::public.member_role[])
    and public.product_shop_id(product_id) = shop_id   -- variant shop must match its product's shop
  );

create policy packaging_select on public.packaging_units for select to authenticated
  using (public.is_shop_member(public.variant_shop_id(variant_id)));
create policy packaging_write on public.packaging_units for all to authenticated
  using (public.has_shop_role(public.variant_shop_id(variant_id), array['owner']::public.member_role[]))
  with check (public.has_shop_role(public.variant_shop_id(variant_id), array['owner']::public.member_role[]));

create policy prices_select on public.product_price_history for select to authenticated
  using (public.is_shop_member(public.variant_shop_id(variant_id)));
create policy prices_insert on public.product_price_history for insert to authenticated
  with check (public.has_shop_role(public.variant_shop_id(variant_id), array['owner']::public.member_role[]));
create policy prices_update on public.product_price_history for update to authenticated
  using (public.has_shop_role(public.variant_shop_id(variant_id), array['owner']::public.member_role[]))
  with check (public.has_shop_role(public.variant_shop_id(variant_id), array['owner']::public.member_role[]));
-- Price history is never deleted (no DELETE policy).

-- ---------- stock counts: managers edit drafts only; confirmation is via RPC (Phase 4/5) ----------
create policy sessions_select on public.stock_count_sessions for select to authenticated
  using (public.is_shop_member(shop_id));
create policy sessions_insert on public.stock_count_sessions for insert to authenticated
  with check (
    public.has_shop_role(shop_id, array['owner','stock_manager']::public.member_role[])
    and status = 'draft' and created_by = auth.uid()
  );
create policy sessions_update_draft on public.stock_count_sessions for update to authenticated
  using (status = 'draft' and public.has_shop_role(shop_id, array['owner','stock_manager']::public.member_role[]))
  with check (status = 'draft');

create policy lines_select on public.stock_count_lines for select to authenticated
  using (public.is_shop_member(public.session_shop_id(session_id)));
create policy lines_write_draft on public.stock_count_lines for all to authenticated
  using (
    public.has_shop_role(public.session_shop_id(session_id), array['owner','stock_manager']::public.member_role[])
    and exists (select 1 from public.stock_count_sessions s where s.id = session_id and s.status = 'draft')
  )
  with check (
    public.has_shop_role(public.session_shop_id(session_id), array['owner','stock_manager']::public.member_role[])
    and exists (select 1 from public.stock_count_sessions s where s.id = session_id and s.status = 'draft')
  );

-- ---------- movements: append-only ----------
create policy movements_select on public.stock_movements for select to authenticated
  using (public.is_shop_member(shop_id));
create policy movements_insert on public.stock_movements for insert to authenticated
  with check (
    public.has_shop_role(shop_id, array['owner','stock_manager']::public.member_role[])
    and created_by = auth.uid()
    and public.variant_shop_id(variant_id) = shop_id
  );

-- ---------- derived / audit data: read-only for clients ----------
create policy daily_sales_select on public.daily_sales for select to authenticated
  using (public.is_shop_member(shop_id));
create policy corrections_select on public.stock_count_corrections for select to authenticated
  using (public.is_shop_member(public.session_shop_id(session_id)));
create policy audit_select on public.audit_logs for select to authenticated
  using (public.has_shop_role(shop_id, array['owner']::public.member_role[]));

-- Defence in depth: audit trail can never be altered by API clients.
revoke insert, update, delete on public.audit_logs from authenticated;
revoke insert, update, delete on public.daily_sales from authenticated;
revoke insert, update, delete on public.stock_count_corrections from authenticated;
revoke insert, delete on public.shops from authenticated;
revoke update, delete on public.stock_movements from authenticated;
revoke delete on public.product_price_history from authenticated;

-- ---------- create_shop(): atomic shop + owner membership ----------
-- Accounts are invitation-only (public sign-ups disabled in Supabase). A user without
-- any membership may create exactly one shop and becomes its owner.
create function public.create_shop(p_name text, p_timezone text default 'Asia/Colombo', p_currency text default 'LKR')
returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_user uuid := auth.uid();
  v_shop uuid;
begin
  if v_user is null then raise exception 'NOT_AUTHENTICATED'; end if;
  if exists (select 1 from public.shop_memberships where user_id = v_user) then
    raise exception 'ALREADY_MEMBER';
  end if;
  if char_length(btrim(p_name)) not between 2 and 80 then raise exception 'INVALID_NAME'; end if;
  if not exists (select 1 from pg_timezone_names where name = p_timezone) then
    raise exception 'INVALID_TIMEZONE';
  end if;

  insert into public.user_profiles (id) values (v_user) on conflict (id) do nothing;
  insert into public.shops (name, timezone, currency, created_by)
  values (btrim(p_name), p_timezone, p_currency, v_user) returning id into v_shop;
  insert into public.shop_memberships (shop_id, user_id, role, status)
  values (v_shop, v_user, 'owner', 'active');
  return v_shop;
end $$;
grant execute on function public.create_shop(text, text, text) to authenticated;
