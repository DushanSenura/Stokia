-- Phase 8: security hardening, team management, count-correction approval, shop settings, valuation policy.

-- =====================================================================================
-- 1. Profiles: email for the team list; clients can change only their own display name + language
-- =====================================================================================
alter table public.user_profiles add column email text;
update public.user_profiles p set email = u.email from auth.users u where u.id = p.id;

create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.user_profiles (id, display_name, email)
  values (new.id, coalesce(nullif(new.raw_user_meta_data->>'display_name', ''), split_part(new.email, '@', 1)), new.email)
  on conflict (id) do update set email = excluded.email;
  return new;
end $$;

-- Column-level grants: a user must not be able to rewrite the email shown to teammates, or create profile rows by hand.
revoke insert, update on public.user_profiles from authenticated;
grant update (display_name, preferred_language) on public.user_profiles to authenticated;

-- =====================================================================================
-- 2. Memberships: a shop can never be left without an active owner; identity columns are immutable
-- =====================================================================================
create function public.shop_memberships_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'UPDATE' and (new.shop_id <> old.shop_id or new.user_id <> old.user_id) then
    raise exception 'MEMBERSHIP_IMMUTABLE';
  end if;
  if old.role = 'owner' and old.status = 'active'
     and (tg_op = 'DELETE' or new.role <> 'owner' or new.status <> 'active')
     and not exists (select 1 from public.shop_memberships m
                      where m.shop_id = old.shop_id and m.role = 'owner' and m.status = 'active' and m.id <> old.id) then
    raise exception 'LAST_OWNER';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end $$;
create trigger shop_memberships_guard_trg before update or delete on public.shop_memberships
  for each row execute function public.shop_memberships_guard();

-- Invited users become active the first time they sign in (called by the app after they set a password).
create function public.accept_invitation() returns integer
language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  if auth.uid() is null then raise exception 'NOT_AUTHENTICATED'; end if;
  update public.shop_memberships set status = 'active' where user_id = auth.uid() and status = 'invited';
  get diagnostics n = row_count;
  return n;
end $$;
revoke execute on function public.accept_invitation() from public, anon;
grant execute on function public.accept_invitation() to authenticated;

-- Used only by the server (service role) to invite someone who already has an auth account.
create function public.find_user_by_email(p_email text) returns uuid
language sql stable security definer set search_path = public, auth as $$
  select id from auth.users where lower(email) = lower(p_email) limit 1;
$$;
revoke execute on function public.find_user_by_email(text) from public, anon, authenticated;
grant execute on function public.find_user_by_email(text) to service_role;

-- =====================================================================================
-- 3. Shop settings: validated, and the timezone is locked once counts exist
-- =====================================================================================
create function public.shops_guard() returns trigger
language plpgsql security definer set search_path = public as $$
declare k text;
begin
  if new.timezone is distinct from old.timezone then
    if not exists (select 1 from pg_timezone_names where name = new.timezone) then raise exception 'INVALID_TIMEZONE'; end if;
    -- Business dates are shop-local calendar dates; changing the zone after counts exist would reinterpret history.
    if exists (select 1 from public.stock_count_sessions where shop_id = old.id and status <> 'draft') then raise exception 'TIMEZONE_LOCKED'; end if;
  end if;
  for k in select jsonb_object_keys(new.settings) loop
    if k not in ('valuation_policy') then raise exception 'INVALID_SETTING'; end if;
  end loop;
  if new.settings ? 'valuation_policy' and (new.settings->>'valuation_policy') not in ('cost_at_count', 'latest_cost') then
    raise exception 'INVALID_SETTING';
  end if;
  if char_length(btrim(new.name)) not between 2 and 80 then raise exception 'INVALID_NAME'; end if;
  return new;
end $$;
create trigger shops_guard_trg before update on public.shops
  for each row execute function public.shops_guard();

revoke update on public.shops from authenticated;
grant update (name, timezone, settings) on public.shops to authenticated;

-- =====================================================================================
-- 4. Valuation policy: cost in force at the count (default) or the latest known cost
-- =====================================================================================
create or replace function public.stock_valuation(p_shop uuid)
returns table (session_id uuid, as_of date, counted_at timestamptz, total_cost numeric,
               valued_count integer, uncosted_count integer, counted_total integer)
language sql stable security invoker set search_path = public as $$
  with pol as (select coalesce((select settings->>'valuation_policy' from public.shops where id = p_shop), 'cost_at_count') as p),
  s as (
    select id, business_date, counted_at from public.stock_count_sessions
     where shop_id = p_shop and status in ('confirmed', 'corrected')
     order by business_date desc limit 1
  ),
  c as (
    select l.normalized_base_quantity as q,
           (select h.amount_lkr from public.product_price_history h
             where h.variant_id = l.variant_id and h.price_type = 'purchase_cost'
               and (case when (select p from pol) = 'latest_cost' then h.effective_to is null
                         else h.effective_from <= s.counted_at and (h.effective_to is null or h.effective_to > s.counted_at) end)
             limit 1) as cost
      from public.stock_count_lines l join s on s.id = l.session_id
     where l.count_status = 'counted'
  )
  select s.id, s.business_date, s.counted_at,
         round(coalesce(sum(c.q * c.cost) filter (where c.cost is not null), 0), 2)::numeric,
         (count(c.q) filter (where c.cost is not null))::integer,
         (count(c.q) filter (where c.cost is null))::integer,
         count(c.q)::integer
    from s left join c on true
   group by s.id, s.business_date, s.counted_at;
$$;

create or replace function public.monthly_report_variants(p_shop uuid, p_month text)
returns table (variant_id uuid, product_id uuid, product_name text, product_code text, category_id uuid, category_name text,
               sku text, size_value numeric, size_unit text, base_unit text, is_active boolean,
               opening numeric, closing numeric, received numeric, returned_in numeric, damaged_out numeric, other_out numeric,
               adjustments numeric, units_sold numeric, estimated_amount numeric,
               days_calculated integer, days_review integer, days_pending integer, max_revision integer,
               closing_cost numeric, closing_value numeric)
language plpgsql stable security invoker set search_path = public as $$
#variable_conflict use_column
declare
  v_start date; v_next date; v_tz text; v_policy text;
  os uuid; cs uuid; o_at timestamptz; c_at timestamptz; lo timestamptz; hi timestamptz;
begin
  if p_month !~ '^\d{4}-(0[1-9]|1[0-2])$' then raise exception 'INVALID_MONTH'; end if;
  v_start := (p_month || '-01')::date;
  v_next := (v_start + interval '1 month')::date;
  select timezone, coalesce(settings->>'valuation_policy', 'cost_at_count') into v_tz, v_policy from public.shops where id = p_shop;
  select id, counted_at into os, o_at from public.stock_count_sessions
   where shop_id = p_shop and business_date = v_start and status in ('confirmed', 'corrected');
  select id, counted_at into cs, c_at from public.stock_count_sessions
   where shop_id = p_shop and business_date = v_next and status in ('confirmed', 'corrected');
  lo := coalesce(o_at, v_start::timestamp at time zone v_tz);
  hi := coalesce(c_at, least(now(), v_next::timestamp at time zone v_tz));

  return query
  select v.id, p.id, p.name, p.product_code, c.id, c.name, v.sku, v.size_value, v.size_unit, v.base_inventory_unit, (v.is_active and p.is_active),
         lo_.normalized_base_quantity, lc_.normalized_base_quantity,
         coalesce(mv.received, 0), coalesce(mv.returned_in, 0), coalesce(mv.damaged_out, 0), coalesce(mv.other_out, 0), coalesce(mv.adjustments, 0),
         coalesce(s.units, 0), coalesce(s.amount, 0), coalesce(s.dc, 0), coalesce(s.dr, 0), coalesce(s.dp, 0), coalesce(s.maxrev, 0),
         cost.amount_lkr,
         case when lc_.normalized_base_quantity is not null and cost.amount_lkr is not null then round(lc_.normalized_base_quantity * cost.amount_lkr, 2) end
    from public.product_variants v
    join public.products p on p.id = v.product_id
    left join public.categories c on c.id = p.category_id
    left join public.stock_count_lines lo_ on lo_.session_id = os and lo_.variant_id = v.id and lo_.count_status = 'counted'
    left join public.stock_count_lines lc_ on lc_.session_id = cs and lc_.variant_id = v.id and lc_.count_status = 'counted'
    left join lateral (
      select sum(d.inferred_base_units_sold) filter (where d.calculation_status in ('calculated', 'recalculated')) as units,
             sum(d.estimated_sales_amount) filter (where d.calculation_status in ('calculated', 'recalculated')) as amount,
             (count(*) filter (where d.calculation_status in ('calculated', 'recalculated')))::integer as dc,
             (count(*) filter (where d.calculation_status = 'needs_review'))::integer as dr,
             (count(*) filter (where d.calculation_status = 'pending'))::integer as dp,
             max(d.calculation_revision) as maxrev,
             count(*) as n
        from public.daily_sales d
       where d.shop_id = p_shop and d.variant_id = v.id and d.sales_date >= v_start and d.sales_date < v_next) s on true
    left join lateral (
      select sum(m.normalized_base_quantity) filter (where m.type = 'stock_received') as received,
             sum(m.normalized_base_quantity) filter (where m.type = 'customer_return') as returned_in,
             -sum(m.normalized_base_quantity) filter (where m.type in ('damaged', 'expired', 'discarded')) as damaged_out,
             -sum(m.normalized_base_quantity) filter (where m.type = 'supplier_return') as other_out,
             sum(m.normalized_base_quantity) filter (where m.type in ('manual_adjustment', 'repacking')) as adjustments
        from public.stock_movements m
       where m.shop_id = p_shop and m.variant_id = v.id and m.effective_at > lo and m.effective_at <= hi) mv on true
    left join lateral (
      select h.amount_lkr from public.product_price_history h
       where h.variant_id = v.id and h.price_type = 'purchase_cost'
         and (case when v_policy = 'latest_cost' then h.effective_to is null
                   else h.effective_from <= c_at and (h.effective_to is null or h.effective_to > c_at) end)
       limit 1) cost on true
   where v.shop_id = p_shop
     and ((v.is_active and p.is_active) or coalesce(s.n, 0) > 0 or lo_.id is not null or lc_.id is not null)
   order by p.name, v.sku;
end $$;

-- =====================================================================================
-- 5. Historical count corrections: request -> owner approval -> applied, fully traceable
-- =====================================================================================
alter table public.stock_count_corrections
  add column status text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'cancelled')),
  add column new_entry_details jsonb,
  add column decided_by uuid references auth.users (id),
  add column decided_at timestamptz,
  add column decision_note text;
create unique index corrections_one_pending on public.stock_count_corrections (session_id, variant_id) where status = 'pending';
create index corrections_session_idx on public.stock_count_corrections (session_id, created_at desc);

-- Applies an approved correction. Internal: never callable by API clients.
create function public._apply_correction(p_id uuid, p_by uuid, p_note text) returns void
language plpgsql security definer set search_path = public as $$
declare
  c public.stock_count_corrections;
  s public.stock_count_sessions;
  l public.stock_count_lines;
begin
  select * into c from public.stock_count_corrections where id = p_id for update;
  if not found or c.status <> 'pending' then raise exception 'NOT_PENDING'; end if;
  select * into s from public.stock_count_sessions where id = c.session_id for update;
  select * into l from public.stock_count_lines where session_id = c.session_id and variant_id = c.variant_id for update;
  -- Someone changed this count line since the request was made: the reviewer must look again.
  if l.normalized_base_quantity is distinct from c.old_quantity then raise exception 'STALE_CORRECTION'; end if;

  update public.stock_count_lines
     set normalized_base_quantity = c.new_quantity, count_status = 'counted',
         entry_details = coalesce(c.new_entry_details, '{}'::jsonb)
                         || jsonb_build_object('corrected', true, 'correction_id', c.id,
                                               'previous', jsonb_build_object('quantity', c.old_quantity, 'details', l.entry_details))
   where id = l.id;
  update public.stock_count_sessions set status = 'corrected', revision = revision + 1 where id = s.id;
  update public.stock_count_corrections set status = 'approved', decided_by = p_by, decided_at = now(), decision_note = p_note where id = c.id;

  -- This count is the closing count of the previous day and the opening count of its own day: recalculate both (with history).
  perform public._recalc_range(s.shop_id, s.business_date - 1, s.business_date, 'count_corrected');

  insert into public.audit_logs (shop_id, user_id, action, entity_type, entity_id, before_data, after_data)
  values (s.shop_id, p_by, 'apply_correction', 'stock_count_lines', l.id,
          jsonb_build_object('quantity', c.old_quantity, 'business_date', s.business_date),
          jsonb_build_object('quantity', c.new_quantity, 'reason', c.reason, 'correction_id', c.id, 'requested_by', c.created_by));
end $$;

create function public.request_count_correction(p_session uuid, p_variant uuid, p_new_qty numeric, p_details jsonb, p_reason text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  s public.stock_count_sessions;
  l public.stock_count_lines;
  v_id uuid;
begin
  select * into s from public.stock_count_sessions where id = p_session for update;
  if not found then raise exception 'NOT_FOUND'; end if;
  if not public.has_shop_role(s.shop_id, array['owner', 'stock_manager']::public.member_role[]) then raise exception 'FORBIDDEN'; end if;
  if s.status = 'draft' then raise exception 'NOT_CONFIRMED'; end if;   -- drafts are simply edited
  if char_length(btrim(coalesce(p_reason, ''))) = 0 then raise exception 'REASON_REQUIRED'; end if;
  if p_new_qty is null or p_new_qty < 0 then raise exception 'INVALID_QUANTITY'; end if;
  select * into l from public.stock_count_lines where session_id = s.id and variant_id = p_variant;
  if not found then raise exception 'INVALID_VARIANT'; end if;
  if l.normalized_base_quantity is not distinct from p_new_qty then raise exception 'NO_CHANGE'; end if;
  if exists (select 1 from public.stock_count_corrections where session_id = s.id and variant_id = p_variant and status = 'pending') then
    raise exception 'ALREADY_PENDING';
  end if;

  insert into public.stock_count_corrections (session_id, variant_id, old_quantity, new_quantity, new_entry_details, reason, created_by, status)
  values (s.id, p_variant, l.normalized_base_quantity, p_new_qty, p_details, btrim(p_reason), auth.uid(), 'pending')
  returning id into v_id;
  insert into public.audit_logs (shop_id, user_id, action, entity_type, entity_id, after_data)
  values (s.shop_id, auth.uid(), 'request_correction', 'stock_count_corrections', v_id,
          jsonb_build_object('business_date', s.business_date, 'old', l.normalized_base_quantity, 'new', p_new_qty, 'reason', btrim(p_reason)));

  -- Owners are the approvers: their own request is approved and applied in the same step (still fully recorded).
  if public.has_shop_role(s.shop_id, array['owner']::public.member_role[]) then
    perform public._apply_correction(v_id, auth.uid(), 'Requested and approved by the owner');
    return jsonb_build_object('id', v_id, 'applied', true);
  end if;
  return jsonb_build_object('id', v_id, 'applied', false);
end $$;

create function public.decide_count_correction(p_id uuid, p_approve boolean, p_note text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare c public.stock_count_corrections; v_shop uuid;
begin
  select * into c from public.stock_count_corrections where id = p_id for update;
  if not found then raise exception 'NOT_FOUND'; end if;
  v_shop := public.session_shop_id(c.session_id);
  if not public.has_shop_role(v_shop, array['owner']::public.member_role[]) then raise exception 'FORBIDDEN'; end if;
  if c.status <> 'pending' then raise exception 'NOT_PENDING'; end if;
  if p_approve then
    perform public._apply_correction(c.id, auth.uid(), nullif(btrim(coalesce(p_note, '')), ''));
    return jsonb_build_object('id', c.id, 'status', 'approved');
  end if;
  if char_length(btrim(coalesce(p_note, ''))) = 0 then raise exception 'NOTE_REQUIRED'; end if;
  update public.stock_count_corrections set status = 'rejected', decided_by = auth.uid(), decided_at = now(), decision_note = btrim(p_note) where id = c.id;
  insert into public.audit_logs (shop_id, user_id, action, entity_type, entity_id, after_data)
  values (v_shop, auth.uid(), 'reject_correction', 'stock_count_corrections', c.id, jsonb_build_object('note', btrim(p_note), 'requested_by', c.created_by));
  return jsonb_build_object('id', c.id, 'status', 'rejected');
end $$;

create function public.cancel_count_correction(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare c public.stock_count_corrections; v_shop uuid;
begin
  select * into c from public.stock_count_corrections where id = p_id for update;
  if not found then raise exception 'NOT_FOUND'; end if;
  v_shop := public.session_shop_id(c.session_id);
  if not (c.created_by = auth.uid() and public.is_shop_member(v_shop)) and not public.has_shop_role(v_shop, array['owner']::public.member_role[]) then
    raise exception 'FORBIDDEN';
  end if;
  if c.status <> 'pending' then raise exception 'NOT_PENDING'; end if;
  update public.stock_count_corrections set status = 'cancelled', decided_by = auth.uid(), decided_at = now() where id = c.id;
end $$;

revoke execute on function public._apply_correction(uuid, uuid, text) from public, anon, authenticated;
revoke execute on function public.request_count_correction(uuid, uuid, numeric, jsonb, text), public.decide_count_correction(uuid, boolean, text),
  public.cancel_count_correction(uuid) from public, anon;
grant execute on function public.request_count_correction(uuid, uuid, numeric, jsonb, text), public.decide_count_correction(uuid, boolean, text),
  public.cancel_count_correction(uuid) to authenticated;

-- =====================================================================================
-- 6. Function privilege hardening (default-deny, then an explicit allowlist)
-- =====================================================================================
-- PostgreSQL grants EXECUTE on every new function to PUBLIC, and `revoke ... from anon` does NOT remove that. So close
-- everything first, make future functions closed by default, and re-open only the intended entry points.
revoke execute on all functions in schema public from public, anon, authenticated;
alter default privileges in schema public revoke execute on functions from public, anon, authenticated;

do $$
declare r record;
begin
  for r in
    select p.oid::regprocedure as sig
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.prokind = 'f'
       and p.proname = any (array[
         -- RPCs called by the app as the signed-in user
         'create_shop', 'save_count_draft', 'confirm_count', 'discard_count_draft', 'record_movement', 'record_repacking', 'reverse_movement',
         'set_variant_price', 'import_catalog', 'record_report_export', 'accept_invitation',
         'request_count_correction', 'decide_count_correction', 'cancel_count_correction',
         -- helpers used inside Row Level Security policies
         'is_shop_member', 'has_shop_role', 'product_shop_id', 'variant_shop_id', 'session_shop_id',
         -- read-only aggregates (SECURITY INVOKER: RLS still applies)
         'sales_daily_summary', 'sales_top_products', 'stock_valuation', 'low_stock_items',
         'analytics_variant_summary', 'analytics_daily', 'analytics_movement_trend', 'monthly_report_variants', 'monthly_report_fingerprint'])
  loop
    execute format('grant execute on function %s to authenticated', r.sig);
  end loop;
end $$;
-- find_user_by_email keeps its service_role-only grant (made above); trigger and internal (_*) functions stay closed.
