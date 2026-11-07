-- Phase 5: stock movements + sales reconciliation.
--
-- THE RULE (mirrors src/lib/calculations/reconcile.ts; a parity test compares both):
--   For variant V and sales date S, with confirmed counts CS (morning of S) and CE (morning of S+1):
--     units_sold = opening(CS) + SUM(signed movement effects with CS.counted_at < effective_at <= CE.counted_at) - closing(CE)
--   * pending       : CE missing, or V was not counted in CS/CE. Never defaulted to zero.
--   * needs_review  : units_sold < 0 (stock rose without a recorded cause). No units, no money.
--   * calculated    : otherwise. Money = units x selling price in force at NOON (shop tz) on S, never "today's" price.
--   * recalculated  : an already-calculated row whose inputs changed; the previous values are kept in daily_sales_revisions.
--   Counts must be consecutive days to form an interval. A skipped day leaves its sales pending (never spread).
--
-- Movement effects are SIGNED in stock_movements.normalized_base_quantity for every type.

-- ---------- movement integrity ----------
alter table public.stock_movements
  add constraint movement_sign check (
    (type in ('stock_received', 'customer_return') and normalized_base_quantity > 0)
    or (type in ('supplier_return', 'damaged', 'expired', 'discarded') and normalized_base_quantity < 0)
    or (type in ('manual_adjustment', 'repacking') and normalized_base_quantity <> 0)),
  add constraint movement_input_positive check (input_quantity > 0),
  add constraint movement_has_reason check (char_length(btrim(coalesce(reason, ''))) > 0 or char_length(btrim(coalesce(reference, ''))) > 0),
  add column reversed_movement_id uuid unique references public.stock_movements (id), -- a movement can be reversed once
  add column group_id uuid;                                                              -- links the two halves of a repacking

-- Clients no longer insert movements directly: record_movement() validates, de-duplicates and recalculates atomically.
drop policy movements_insert on public.stock_movements;
revoke insert on public.stock_movements from authenticated;

-- ---------- daily_sales: explanation + revision history ----------
alter table public.daily_sales
  add column breakdown jsonb,          -- opening / movements / closing used for the figure (explains every number)
  add column pending_reason text;      -- why not calculated (awaiting_next_count, missing_count, ..., stock_increase_unexplained)

create table public.daily_sales_revisions (
  id uuid primary key default gen_random_uuid(),
  daily_sales_id uuid not null references public.daily_sales (id) on delete cascade,
  shop_id uuid not null references public.shops (id) on delete cascade,
  revision integer not null,
  calculation_status public.sales_calc_status not null,
  inferred_base_units_sold numeric(18,3),
  estimated_sales_amount numeric(14,2),
  price_reference numeric(14,2),
  breakdown jsonb,
  pending_reason text,
  opening_count_id uuid,
  closing_count_id uuid,
  calculated_at timestamptz not null,
  superseded_at timestamptz not null default now(),
  superseded_reason text
);
create index daily_sales_revisions_ds_idx on public.daily_sales_revisions (daily_sales_id, revision);
alter table public.daily_sales_revisions enable row level security;
create policy daily_sales_revisions_select on public.daily_sales_revisions for select to authenticated
  using (public.is_shop_member(shop_id));
revoke insert, update, delete on public.daily_sales_revisions from authenticated;
revoke all on public.daily_sales_revisions from anon;

-- ---------- the reconciliation (internal; never callable by API clients) ----------
create function public._recalc_sales_day(p_shop uuid, p_date date, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
declare
  cs public.stock_count_sessions;
  ce public.stock_count_sessions;
  v_tz text;
  v_noon timestamptz;
  v_later boolean;
  v_n int;
begin
  select * into cs from public.stock_count_sessions
   where shop_id = p_shop and business_date = p_date and status in ('confirmed', 'corrected');
  if not found then return; end if;  -- no opening count for this day: nothing to reconcile
  select * into ce from public.stock_count_sessions
   where shop_id = p_shop and business_date = p_date + 1 and status in ('confirmed', 'corrected');

  select timezone into v_tz from public.shops where id = p_shop;
  v_noon := (p_date::timestamp + interval '12 hours') at time zone v_tz;   -- the price instant for this sales date
  v_later := exists (select 1 from public.stock_count_sessions
                      where shop_id = p_shop and status in ('confirmed', 'corrected') and business_date > p_date + 1);

  with base as (
    select ls.variant_id, ls.id as open_line_id, ls.count_status as open_status, ls.normalized_base_quantity as open_q,
           le.id as close_line_id, le.count_status as close_status, le.normalized_base_quantity as close_q
      from public.stock_count_lines ls
      left join public.stock_count_lines le on le.session_id = ce.id and le.variant_id = ls.variant_id
     where ls.session_id = cs.id
  ),
  mv as (
    select m.variant_id,
           sum(m.normalized_base_quantity) filter (where m.type = 'stock_received') as received,
           sum(m.normalized_base_quantity) filter (where m.type = 'customer_return') as returns,
           -sum(m.normalized_base_quantity) filter (where m.type in ('damaged', 'expired', 'discarded')) as damaged,
           -sum(m.normalized_base_quantity) filter (where m.type = 'supplier_return') as other_out,
           sum(m.normalized_base_quantity) filter (where m.type in ('manual_adjustment', 'repacking')) as adjustments
      from public.stock_movements m
     where m.shop_id = p_shop and ce.id is not null
       and m.effective_at > cs.counted_at and m.effective_at <= ce.counted_at
     group by m.variant_id
  ),
  x as (
    select b.*, coalesce(mv.received, 0) as rec, coalesce(mv.returns, 0) as ret, coalesce(mv.damaged, 0) as dmg,
           coalesce(mv.other_out, 0) as oth, coalesce(mv.adjustments, 0) as adj,
           (ce.id is not null and b.open_status = 'counted' and coalesce(b.close_status = 'counted', false)) as complete
      from base b left join mv on mv.variant_id = b.variant_id
  ),
  y as (
    select x.*, case when x.complete then x.open_q + x.rec + x.ret - x.dmg - x.oth + x.adj - x.close_q end as sold
      from x
  ),
  calc as (
    select y.variant_id, y.open_line_id, y.close_line_id,
           case when not y.complete then 'pending' when y.sold < 0 then 'needs_review' else 'calculated' end as status,
           case when ce.id is null then (case when v_later then 'missing_count' else 'awaiting_next_count' end)
                when y.open_status <> 'counted' then 'opening_not_counted'
                when y.close_status is distinct from 'counted' then 'closing_not_counted'
                when y.sold < 0 then 'stock_increase_unexplained' end as reason,
           case when y.complete and y.sold >= 0 then y.sold end as units,
           pr.amount_lkr as price,
           case when y.complete and y.sold >= 0 and pr.amount_lkr is not null then round(y.sold * pr.amount_lkr, 2) end as amount,
           case when ce.id is null then null else jsonb_build_object(
             'opening', y.open_q, 'closing', y.close_q, 'received', y.rec, 'returns', y.ret,
             'damaged', y.dmg, 'other_out', y.oth, 'adjustments', y.adj) end as breakdown
      from y
      left join lateral (
        select h.amount_lkr from public.product_price_history h
         where h.variant_id = y.variant_id and h.price_type = 'selling'
           and h.effective_from <= v_noon and (h.effective_to is null or h.effective_to > v_noon)
         limit 1) pr on true
  ),
  old as (select * from public.daily_sales where shop_id = p_shop and sales_date = p_date),
  changed as (
    select c.*, o.id as old_id, o.calculation_status::text as old_status
      from calc c left join old o on o.variant_id = c.variant_id
     where o.id is null or (
       o.inferred_base_units_sold, o.estimated_sales_amount, o.price_reference,
       case when o.calculation_status = 'recalculated' then 'calculated' else o.calculation_status::text end,
       o.breakdown, o.pending_reason, o.opening_count_id, o.closing_count_id
     ) is distinct from (c.units, c.amount, c.price, c.status, c.breakdown, c.reason, c.open_line_id, c.close_line_id)
  ),
  hist as (
    insert into public.daily_sales_revisions (daily_sales_id, shop_id, revision, calculation_status, inferred_base_units_sold,
        estimated_sales_amount, price_reference, breakdown, pending_reason, opening_count_id, closing_count_id, calculated_at, superseded_reason)
    select o.id, o.shop_id, o.calculation_revision, o.calculation_status, o.inferred_base_units_sold, o.estimated_sales_amount,
           o.price_reference, o.breakdown, o.pending_reason, o.opening_count_id, o.closing_count_id, o.calculated_at, p_reason
      from public.daily_sales o join changed c on c.old_id = o.id
     where o.calculation_status <> 'pending'   -- a pending placeholder has no figures: replacing it is the FIRST calculation, not a revision
    returning 1
  ),
  up as (
    insert into public.daily_sales (shop_id, variant_id, sales_date, opening_count_id, closing_count_id, inferred_base_units_sold,
        estimated_sales_amount, price_reference, calculation_status, calculation_revision, calculated_at, breakdown, pending_reason)
    select p_shop, c.variant_id, p_date, c.open_line_id, c.close_line_id, c.units, c.amount, c.price,
           (case when c.status = 'calculated' and c.old_id is not null and c.old_status in ('calculated', 'recalculated', 'needs_review')
                 then 'recalculated' else c.status end)::public.sales_calc_status,
           1, now(), c.breakdown, c.reason
      from changed c
    on conflict (shop_id, variant_id, sales_date) do update set
      opening_count_id = excluded.opening_count_id, closing_count_id = excluded.closing_count_id,
      inferred_base_units_sold = excluded.inferred_base_units_sold, estimated_sales_amount = excluded.estimated_sales_amount,
      price_reference = excluded.price_reference, calculation_status = excluded.calculation_status,
      calculation_revision = public.daily_sales.calculation_revision + case when public.daily_sales.calculation_status = 'pending' then 0 else 1 end,
      calculated_at = now(),
      breakdown = excluded.breakdown, pending_reason = excluded.pending_reason
    returning 1
  )
  select (select count(*) from hist) + (select count(*) from up) into v_n;
end $$;

-- Recalculate every day that has a confirmed opening count within [p_from, p_to].
create function public._recalc_range(p_shop uuid, p_from date, p_to date, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
declare r record;
begin
  for r in select business_date from public.stock_count_sessions
            where shop_id = p_shop and status in ('confirmed', 'corrected') and business_date between p_from and p_to
            order by business_date
  loop
    perform public._recalc_sales_day(p_shop, r.business_date, p_reason);
  end loop;
end $$;

-- A movement affects exactly one interval: the one opened by the latest count taken before it.
create function public._recalc_for_movement(p_shop uuid, p_effective timestamptz, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
declare v_date date;
begin
  select business_date into v_date from public.stock_count_sessions
   where shop_id = p_shop and status in ('confirmed', 'corrected') and counted_at < p_effective
   order by counted_at desc limit 1;
  if v_date is not null then perform public._recalc_sales_day(p_shop, v_date, p_reason); end if;
end $$;

revoke execute on function public._recalc_sales_day(uuid, date, text), public._recalc_range(uuid, date, date, text),
  public._recalc_for_movement(uuid, timestamptz, text) from public, anon, authenticated;

-- ---------- confirm_count now reconciles in the SAME transaction ----------
-- (replaces the Phase 4 version; counted_at is no longer overwritten: it is the moment counting STARTED,
--  which is what decides whether an early-morning delivery belongs before or after the count)
create or replace function public.confirm_count(p_session uuid, p_revision integer, p_ack_missing boolean default false)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  s public.stock_count_sessions;
  v_counted int;
  v_missing int;
  v_prev date;
begin
  select * into s from public.stock_count_sessions where id = p_session for update;
  if not found then raise exception 'NOT_FOUND'; end if;
  if not public.has_shop_role(s.shop_id, array['owner','stock_manager']::public.member_role[]) then raise exception 'FORBIDDEN'; end if;

  if s.status <> 'draft' then
    return jsonb_build_object('session_id', s.id, 'revision', s.revision, 'already_confirmed', true, 'business_date', s.business_date);
  end if;
  if p_revision is distinct from s.revision then raise exception 'REVISION_CONFLICT'; end if;
  if exists (select 1 from public.stock_count_sessions where shop_id = s.shop_id and status <> 'draft' and business_date >= s.business_date) then
    raise exception 'COUNT_OUT_OF_ORDER';
  end if;

  select count(*) into v_counted from public.stock_count_lines where session_id = s.id and count_status = 'counted';
  if v_counted = 0 then raise exception 'NO_COUNTS'; end if;

  select count(*) into v_missing
    from public.product_variants v join public.products p on p.id = v.product_id
   where v.shop_id = s.shop_id and v.is_active and p.is_active
     and not exists (select 1 from public.stock_count_lines l where l.session_id = s.id and l.variant_id = v.id);
  if v_missing > 0 and not coalesce(p_ack_missing, false) then raise exception 'MISSING_COUNTS'; end if;

  insert into public.stock_count_lines (session_id, variant_id, normalized_base_quantity, count_status)
  select s.id, v.id, null, 'not_counted'
    from public.product_variants v join public.products p on p.id = v.product_id
   where v.shop_id = s.shop_id and v.is_active and p.is_active
     and not exists (select 1 from public.stock_count_lines l where l.session_id = s.id and l.variant_id = v.id);

  update public.stock_count_sessions
     set status = 'confirmed', confirmed_by = auth.uid(), confirmed_at = now(), revision = revision + 1
   where id = s.id returning * into s;

  -- Atomic with the confirmation: if reconciliation fails, the count is NOT confirmed.
  select max(business_date) into v_prev from public.stock_count_sessions
   where shop_id = s.shop_id and status in ('confirmed', 'corrected') and business_date < s.business_date;
  perform public._recalc_range(s.shop_id, coalesce(v_prev, s.business_date), s.business_date, 'count_confirmed');

  insert into public.audit_logs (shop_id, user_id, action, entity_type, entity_id, after_data)
  values (s.shop_id, auth.uid(), 'confirm_count', 'stock_count_sessions', s.id,
          jsonb_build_object('business_date', s.business_date, 'counted', v_counted, 'not_counted', v_missing));
  return jsonb_build_object('session_id', s.id, 'revision', s.revision, 'already_confirmed', false,
                            'business_date', s.business_date, 'counted', v_counted, 'not_counted', v_missing);
end $$;

-- ---------- record_movement ----------
-- p_effect is the SIGNED base-unit effect computed by the server; it is re-verified here against the unit's multiplier.
create function public.record_movement(
  p_shop uuid, p_variant uuid, p_type public.movement_type, p_input_quantity numeric, p_input_unit uuid, p_effect numeric,
  p_effective_at timestamptz, p_reason text, p_reference text, p_supplier text, p_cost numeric, p_key text
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_ok boolean;
  v_mult numeric;
  v_unit_variant uuid;
  v_id uuid;
  v_existing public.stock_movements;
begin
  if not public.has_shop_role(p_shop, array['owner','stock_manager']::public.member_role[]) then raise exception 'FORBIDDEN'; end if;
  if p_type = 'repacking' then raise exception 'USE_REPACKING'; end if;
  if p_key is null or char_length(btrim(p_key)) = 0 then raise exception 'KEY_REQUIRED'; end if;
  if p_effective_at > now() + interval '5 minutes' then raise exception 'FUTURE_TIME'; end if;
  if p_effective_at < now() - interval '400 days' then raise exception 'TOO_OLD'; end if;
  if char_length(btrim(coalesce(p_reason, ''))) = 0 and char_length(btrim(coalesce(p_reference, ''))) = 0 then raise exception 'REASON_REQUIRED'; end if;

  select exists (select 1 from public.product_variants v join public.products p on p.id = v.product_id
                  where v.id = p_variant and v.shop_id = p_shop and v.is_active and p.is_active) into v_ok;
  if not v_ok then raise exception 'INVALID_VARIANT'; end if;

  if p_input_unit is not null then
    select base_unit_multiplier, variant_id into v_mult, v_unit_variant from public.packaging_units where id = p_input_unit and is_active;
    if v_unit_variant is distinct from p_variant then raise exception 'INVALID_UNIT'; end if;
    if p_input_quantity <> trunc(p_input_quantity) then raise exception 'FRACTIONAL_PACKAGE'; end if;
  else
    v_mult := 1;
  end if;
  if abs(p_effect) <> round(p_input_quantity * v_mult, 3) then raise exception 'EFFECT_MISMATCH'; end if;

  insert into public.stock_movements (shop_id, variant_id, type, input_quantity, input_unit_id, normalized_base_quantity, effective_at,
                                      reason, reference, supplier, purchase_cost_lkr, idempotency_key, created_by)
  values (p_shop, p_variant, p_type, p_input_quantity, p_input_unit, p_effect, p_effective_at,
          nullif(btrim(p_reason), ''), nullif(btrim(p_reference), ''), nullif(btrim(p_supplier), ''), p_cost, btrim(p_key), auth.uid())
  on conflict (shop_id, idempotency_key) do nothing
  returning id into v_id;

  if v_id is null then
    -- Retry of a request that already succeeded: return the original, apply nothing twice.
    select * into v_existing from public.stock_movements where shop_id = p_shop and idempotency_key = btrim(p_key);
    if v_existing.variant_id <> p_variant or v_existing.type <> p_type or v_existing.normalized_base_quantity <> p_effect then
      raise exception 'IDEMPOTENCY_MISMATCH';
    end if;
    return jsonb_build_object('id', v_existing.id, 'duplicate', true);
  end if;

  perform public._recalc_for_movement(p_shop, p_effective_at, 'movement_recorded');
  return jsonb_build_object('id', v_id, 'duplicate', false);
end $$;

-- ---------- record_repacking: explicit conversion between two sizes (never merged silently) ----------
create function public.record_repacking(
  p_shop uuid, p_from_variant uuid, p_from_qty numeric, p_to_variant uuid, p_to_qty numeric,
  p_effective_at timestamptz, p_reason text, p_reference text, p_key text
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_group uuid := gen_random_uuid();
  v_out uuid;
  v_in uuid;
  v_existing public.stock_movements;
begin
  if not public.has_shop_role(p_shop, array['owner','stock_manager']::public.member_role[]) then raise exception 'FORBIDDEN'; end if;
  if p_from_variant = p_to_variant then raise exception 'SAME_VARIANT'; end if;
  if p_from_qty <= 0 or p_to_qty <= 0 then raise exception 'INVALID_QUANTITY'; end if;
  if p_key is null or char_length(btrim(p_key)) = 0 then raise exception 'KEY_REQUIRED'; end if;
  if p_effective_at > now() + interval '5 minutes' then raise exception 'FUTURE_TIME'; end if;
  if p_effective_at < now() - interval '400 days' then raise exception 'TOO_OLD'; end if;
  if char_length(btrim(coalesce(p_reason, ''))) = 0 and char_length(btrim(coalesce(p_reference, ''))) = 0 then raise exception 'REASON_REQUIRED'; end if;
  if (select count(*) from public.product_variants v join public.products p on p.id = v.product_id
       where v.id in (p_from_variant, p_to_variant) and v.shop_id = p_shop and v.is_active and p.is_active) <> 2 then
    raise exception 'INVALID_VARIANT';
  end if;

  insert into public.stock_movements (shop_id, variant_id, type, input_quantity, normalized_base_quantity, effective_at, reason, reference, idempotency_key, created_by, group_id)
  values (p_shop, p_from_variant, 'repacking', p_from_qty, -p_from_qty, p_effective_at, nullif(btrim(p_reason), ''), nullif(btrim(p_reference), ''), btrim(p_key) || ':out', auth.uid(), v_group)
  on conflict (shop_id, idempotency_key) do nothing returning id into v_out;

  if v_out is null then
    select * into v_existing from public.stock_movements where shop_id = p_shop and idempotency_key = btrim(p_key) || ':out';
    if v_existing.variant_id <> p_from_variant or v_existing.normalized_base_quantity <> -p_from_qty then raise exception 'IDEMPOTENCY_MISMATCH'; end if;
    return jsonb_build_object('group_id', v_existing.group_id, 'duplicate', true);
  end if;

  insert into public.stock_movements (shop_id, variant_id, type, input_quantity, normalized_base_quantity, effective_at, reason, reference, idempotency_key, created_by, group_id)
  values (p_shop, p_to_variant, 'repacking', p_to_qty, p_to_qty, p_effective_at, nullif(btrim(p_reason), ''), nullif(btrim(p_reference), ''), btrim(p_key) || ':in', auth.uid(), v_group)
  returning id into v_in;

  perform public._recalc_for_movement(p_shop, p_effective_at, 'repacking_recorded');
  return jsonb_build_object('group_id', v_group, 'duplicate', false);
end $$;

-- ---------- reverse_movement: movements are never edited or deleted ----------
-- The compensating entry takes effect at the ORIGINAL time, so the interval that was wrong is fixed
-- (and recalculated with history), instead of distorting today's interval.
create function public.reverse_movement(p_movement uuid, p_reason text, p_key text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  o public.stock_movements;
  v_id uuid;
  v_existing public.stock_movements;
begin
  select * into o from public.stock_movements where id = p_movement for update;
  if not found then raise exception 'NOT_FOUND'; end if;
  if not public.has_shop_role(o.shop_id, array['owner','stock_manager']::public.member_role[]) then raise exception 'FORBIDDEN'; end if;
  if char_length(btrim(coalesce(p_reason, ''))) = 0 then raise exception 'REASON_REQUIRED'; end if;
  if p_key is null or char_length(btrim(p_key)) = 0 then raise exception 'KEY_REQUIRED'; end if;
  if o.reversed_movement_id is not null then raise exception 'IS_REVERSAL'; end if;

  insert into public.stock_movements (shop_id, variant_id, type, input_quantity, normalized_base_quantity, effective_at, reason, reference,
                                      idempotency_key, created_by, reversed_movement_id)
  values (o.shop_id, o.variant_id, 'manual_adjustment', abs(o.normalized_base_quantity), -o.normalized_base_quantity, o.effective_at,
          btrim(p_reason), 'Reversal of ' || o.id::text, btrim(p_key), auth.uid(), o.id)
  on conflict do nothing
  returning id into v_id;

  if v_id is null then
    select * into v_existing from public.stock_movements where reversed_movement_id = o.id;
    if found then return jsonb_build_object('id', v_existing.id, 'duplicate', true); end if;
    raise exception 'IDEMPOTENCY_MISMATCH'; -- key used for something else
  end if;

  perform public._recalc_for_movement(o.shop_id, o.effective_at, 'movement_reversed');
  return jsonb_build_object('id', v_id, 'duplicate', false);
end $$;

revoke execute on function public.record_movement(uuid, uuid, public.movement_type, numeric, uuid, numeric, timestamptz, text, text, text, numeric, text),
  public.record_repacking(uuid, uuid, numeric, uuid, numeric, timestamptz, text, text, text),
  public.reverse_movement(uuid, text, text) from public, anon;
grant execute on function public.record_movement(uuid, uuid, public.movement_type, numeric, uuid, numeric, timestamptz, text, text, text, numeric, text),
  public.record_repacking(uuid, uuid, numeric, uuid, numeric, timestamptz, text, text, text),
  public.reverse_movement(uuid, text, text) to authenticated;
