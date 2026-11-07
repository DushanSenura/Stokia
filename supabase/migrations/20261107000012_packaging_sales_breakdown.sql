-- Phase 12: packaging-level selling, and the optional breakdown of a day's inferred sales.
--
-- ADDITIVE and backward compatible: no existing column changes meaning, no existing row changes.
--   * Existing packaging units keep counting as before (can_be_counted defaults true) and are NOT sellable (can_be_sold defaults false),
--     so every existing day keeps exactly the figure it has now (inferred units x the variant's selling price).
--   * The variant's existing selling price (product_price_history) stays the price of the BASE unit ("Piece").
--   * A packaging unit that can be sold gets its own price history (packaging_unit_price_history).
--
-- THE RULE (mirrors src/lib/calculations/sales-breakdown.ts; a parity test runs both on the same cases):
--   For a day with inferred base units sold S, the owner may say how many whole sellable packages were sold (e.g. 4 boxes of 20).
--     packaged     = SUM(packages x base units per package)             must be <= S
--     remainder    = S - packaged                                       sold in the base unit (e.g. loose pieces)
--     revenue      = SUM(packages x package price) + remainder x base price, each price the one in force at NOON (shop tz) on the sales date
--   A breakdown NEVER changes stock: it only splits the already-inferred sale. When no breakdown exists the day keeps S x base price,
--   and reports call it an estimate with an unknown packaging mix.

-- ---------- 1. what a packaging unit may be used for ----------
alter table public.packaging_units
  add column can_be_sold boolean not null default false,
  add column can_be_counted boolean not null default true;

-- The base inventory unit ("Piece") has no packaging row, so its sale identity lives on the variant.
alter table public.product_variants
  add column base_unit_sellable boolean not null default true;

-- One explicit list of every unit a product can be counted or sold in, base unit included.
-- unit_key is 'base' for the base inventory unit, otherwise the packaging unit's id.
create view public.sale_units with (security_invoker = true) as
  select v.id as variant_id, 'base'::text as unit_key, null::uuid as packaging_unit_id, true as is_base_unit,
         v.base_inventory_unit as name, 1::numeric as base_unit_multiplier,
         v.base_unit_sellable as can_be_sold, true as can_be_counted, true as is_active
    from public.product_variants v
  union all
  select pu.variant_id, pu.id::text, pu.id, false, pu.name, pu.base_unit_multiplier, pu.can_be_sold, pu.can_be_counted, pu.is_active
    from public.packaging_units pu;
revoke all on public.sale_units from anon;
grant select on public.sale_units to authenticated;

-- ---------- 2. packaging-level selling prices (history is never rewritten or deleted) ----------
create table public.packaging_unit_price_history (
  id uuid primary key default gen_random_uuid(),
  unit_id uuid not null references public.packaging_units (id) on delete restrict,
  amount_lkr numeric(14,2) not null check (amount_lkr >= 0),
  effective_from timestamptz not null,
  effective_to timestamptz,
  created_at timestamptz not null default now(),
  check (effective_to is null or effective_to > effective_from)
);
alter table public.packaging_unit_price_history
  add constraint packaging_price_no_overlap exclude using gist (
    unit_id with =, tstzrange(effective_from, coalesce(effective_to, 'infinity')) with &&
  );
create index packaging_price_lookup_idx on public.packaging_unit_price_history (unit_id, effective_from desc);

alter table public.packaging_unit_price_history enable row level security;
create policy packaging_prices_select on public.packaging_unit_price_history for select to authenticated
  using (public.is_shop_member(public.variant_shop_id((select pu.variant_id from public.packaging_units pu where pu.id = unit_id))));
-- Written only through set_packaging_price() below.
revoke insert, update, delete on public.packaging_unit_price_history from authenticated;
revoke all on public.packaging_unit_price_history from anon;

-- Owner sets the price of a SELLABLE packaging unit from a moment on. The previous period is closed, never edited or deleted.
create function public.set_packaging_price(p_unit uuid, p_amount numeric, p_effective_from timestamptz default now())
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_unit public.packaging_units;
  v_shop uuid;
  v_last timestamptz;
  v_id uuid;
begin
  select * into v_unit from public.packaging_units where id = p_unit;
  if not found then raise exception 'NOT_FOUND'; end if;
  v_shop := public.variant_shop_id(v_unit.variant_id);
  if v_shop is null or not public.has_shop_role(v_shop, array['owner']::public.member_role[]) then raise exception 'FORBIDDEN'; end if;
  if not v_unit.can_be_sold then raise exception 'NOT_SELLABLE'; end if;
  if p_amount is null or p_amount < 0 then raise exception 'INVALID_AMOUNT'; end if;

  select max(effective_from) into v_last from public.packaging_unit_price_history where unit_id = p_unit;
  if v_last is not null and p_effective_from <= v_last then raise exception 'PRICE_PERIOD_CONFLICT'; end if;

  update public.packaging_unit_price_history set effective_to = p_effective_from where unit_id = p_unit and effective_to is null;
  insert into public.packaging_unit_price_history (unit_id, amount_lkr, effective_from)
  values (p_unit, round(p_amount, 2), p_effective_from) returning id into v_id;

  insert into public.audit_logs (shop_id, user_id, action, entity_type, entity_id, after_data)
  values (v_shop, auth.uid(), 'set_price', 'packaging_units', p_unit,
          jsonb_build_object('amount_lkr', round(p_amount, 2), 'effective_from', p_effective_from));
  return v_id;
end $$;
revoke execute on function public.set_packaging_price(uuid, numeric, timestamptz) from public, anon;
grant execute on function public.set_packaging_price(uuid, numeric, timestamptz) to authenticated;

-- ---------- 3. recorded breakdowns, their lines, and the full history ----------
alter table public.daily_sales
  add column packaging_status text not null default 'unknown' check (packaging_status in ('unknown', 'known', 'stale'));
alter table public.daily_sales_revisions add column packaging_status text;

create table public.sales_breakdowns (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops (id) on delete cascade,
  variant_id uuid not null references public.product_variants (id) on delete restrict,
  sales_date date not null,
  -- stale: the figures it was checked against changed (a count was corrected) and it no longer fits. Kept, never silently used.
  status text not null default 'active' check (status in ('active', 'stale')),
  revision integer not null default 1,
  inferred_base_units numeric(18,3) not null,
  packaged_base_units numeric(18,3) not null check (packaged_base_units >= 0),
  remainder_base_units numeric(18,3) not null check (remainder_base_units >= 0),
  amount numeric(14,2),
  note text,
  created_by uuid references auth.users (id),
  created_at timestamptz not null default now(),
  updated_by uuid references auth.users (id),
  updated_at timestamptz not null default now(),
  unique (shop_id, variant_id, sales_date)
);
create index sales_breakdowns_shop_date_idx on public.sales_breakdowns (shop_id, sales_date);

create table public.sales_breakdown_lines (
  id uuid primary key default gen_random_uuid(),
  breakdown_id uuid not null references public.sales_breakdowns (id) on delete cascade,
  packaging_unit_id uuid references public.packaging_units (id) on delete restrict,
  is_base_unit boolean not null,
  unit_name text not null,
  quantity numeric(18,3) not null check (quantity >= 0),
  base_units numeric(18,3) not null check (base_units >= 0),
  unit_price numeric(14,2) not null check (unit_price >= 0),
  amount numeric(14,2) not null check (amount >= 0),
  -- explicit sale-unit identity: the base unit is flagged, never "a null that happens to mean base"
  check ((packaging_unit_id is null) = is_base_unit),
  check (is_base_unit or quantity = trunc(quantity))   -- sellable packages are whole numbers
);
create index sales_breakdown_lines_idx on public.sales_breakdown_lines (breakdown_id);

create table public.sales_breakdown_revisions (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops (id) on delete cascade,
  variant_id uuid not null,
  sales_date date not null,
  revision integer not null,
  action text not null check (action in ('created', 'updated', 'cleared', 'recalculated', 'marked_stale', 'restored')),
  snapshot jsonb,                 -- what the breakdown was after this action (null once cleared)
  reason text,
  idempotency_key text,
  request_hash text,
  created_by uuid,                -- null for the system's own recalculation
  created_at timestamptz not null default now()
);
create index sales_breakdown_revisions_idx on public.sales_breakdown_revisions (shop_id, variant_id, sales_date, created_at);
create unique index sales_breakdown_revisions_key_uq on public.sales_breakdown_revisions (shop_id, idempotency_key) where idempotency_key is not null;

alter table public.sales_breakdowns enable row level security;
alter table public.sales_breakdown_lines enable row level security;
alter table public.sales_breakdown_revisions enable row level security;
create policy sales_breakdowns_select on public.sales_breakdowns for select to authenticated using (public.is_shop_member(shop_id));
create policy sales_breakdown_lines_select on public.sales_breakdown_lines for select to authenticated
  using (public.is_shop_member((select b.shop_id from public.sales_breakdowns b where b.id = breakdown_id)));
create policy sales_breakdown_revisions_select on public.sales_breakdown_revisions for select to authenticated using (public.is_shop_member(shop_id));
-- Written only by the functions below (they check the role, the figures and the idempotency key).
revoke insert, update, delete on public.sales_breakdowns, public.sales_breakdown_lines, public.sales_breakdown_revisions from authenticated;
revoke all on public.sales_breakdowns, public.sales_breakdown_lines, public.sales_breakdown_revisions from anon;

-- ---------- 4. the shared rule (internal) ----------
-- Validates a set of whole-package counts against the inferred units sold and prices them with the prices in force at noon on the
-- sales date. Returns {ok:true, amount, packaged, remainder, lines:[...]} or {ok:false, error:'CODE'}. Never writes anything.
create function public._breakdown_compute(p_shop uuid, p_variant uuid, p_date date, p_inferred numeric, p_lines jsonb, p_require_active boolean default false)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_tz text;
  v_noon timestamptz;
  e jsonb;
  r public.packaging_units;
  v_unit uuid;
  v_qty numeric;
  v_price numeric;
  v_packaged numeric := 0;
  v_amount numeric := 0;
  v_out jsonb := '[]'::jsonb;
  v_seen uuid[] := '{}';
  v_remainder numeric;
  v_base_price numeric;
  v_base_ok boolean;
begin
  if p_inferred is null or p_inferred < 0 then return jsonb_build_object('ok', false, 'error', 'NOT_CALCULATED'); end if;
  select timezone into v_tz from public.shops where id = p_shop;
  v_noon := (p_date::timestamp + interval '12 hours') at time zone v_tz;

  for e in select value from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) loop
    begin
      v_unit := (e->>'unit_id')::uuid;
      v_qty := (e->>'quantity')::numeric;
    exception when others then
      return jsonb_build_object('ok', false, 'error', 'INVALID_LINE');
    end;
    if v_unit is null or v_qty is null then return jsonb_build_object('ok', false, 'error', 'INVALID_LINE'); end if;
    if v_qty < 0 then return jsonb_build_object('ok', false, 'error', 'NEGATIVE_QUANTITY'); end if;
    if v_qty <> trunc(v_qty) then return jsonb_build_object('ok', false, 'error', 'FRACTIONAL_PACKAGE'); end if;
    if v_unit = any (v_seen) then return jsonb_build_object('ok', false, 'error', 'DUPLICATE_UNIT'); end if;
    v_seen := v_seen || v_unit;

    select * into r from public.packaging_units where id = v_unit and variant_id = p_variant;
    if not found then return jsonb_build_object('ok', false, 'error', 'INVALID_UNIT'); end if;
    if not r.can_be_sold then return jsonb_build_object('ok', false, 'error', 'NOT_SELLABLE'); end if;
    if p_require_active and not r.is_active then return jsonb_build_object('ok', false, 'error', 'INVALID_UNIT'); end if;
    if v_qty = 0 then continue; end if;

    select amount_lkr into v_price from public.packaging_unit_price_history
     where unit_id = v_unit and effective_from <= v_noon and (effective_to is null or effective_to > v_noon) limit 1;
    if v_price is null then return jsonb_build_object('ok', false, 'error', 'PRICE_MISSING'); end if;

    v_packaged := v_packaged + v_qty * r.base_unit_multiplier;
    v_amount := v_amount + round(v_qty * v_price, 2);
    v_out := v_out || jsonb_build_array(jsonb_build_object(
      'unit_id', v_unit, 'is_base_unit', false, 'name', r.name, 'quantity', v_qty,
      'base_units', v_qty * r.base_unit_multiplier, 'unit_price', v_price, 'amount', round(v_qty * v_price, 2)));
  end loop;

  if v_packaged > p_inferred then return jsonb_build_object('ok', false, 'error', 'EXCEEDS_INFERRED'); end if;
  v_remainder := p_inferred - v_packaged;

  if v_remainder > 0 then
    select base_unit_sellable into v_base_ok from public.product_variants where id = p_variant;
    if not coalesce(v_base_ok, false) then return jsonb_build_object('ok', false, 'error', 'BASE_NOT_SELLABLE'); end if;
    select h.amount_lkr into v_base_price from public.product_price_history h
     where h.variant_id = p_variant and h.price_type = 'selling' and h.effective_from <= v_noon and (h.effective_to is null or h.effective_to > v_noon) limit 1;
    if v_base_price is null then return jsonb_build_object('ok', false, 'error', 'PRICE_MISSING'); end if;
    v_amount := v_amount + round(v_remainder * v_base_price, 2);
    v_out := v_out || jsonb_build_array(jsonb_build_object(
      'unit_id', null, 'is_base_unit', true, 'name', (select base_inventory_unit from public.product_variants where id = p_variant),
      'quantity', v_remainder, 'base_units', v_remainder, 'unit_price', v_base_price, 'amount', round(v_remainder * v_base_price, 2)));
  end if;

  return jsonb_build_object('ok', true, 'amount', v_amount, 'packaged', v_packaged, 'remainder', v_remainder, 'lines', v_out);
end $$;
revoke execute on function public._breakdown_compute(uuid, uuid, date, numeric, jsonb, boolean) from public, anon, authenticated;

-- ---------- 5. the reconciliation now honours a valid breakdown ----------
create or replace function public._recalc_sales_day(p_shop uuid, p_date date, p_reason text) returns void
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
  -- a recorded breakdown (whole packages known) for this product and day, as the lines the shared rule re-checks
  bk as (
    select b.variant_id, b.id,
           coalesce((select jsonb_agg(jsonb_build_object('unit_id', l.packaging_unit_id, 'quantity', l.quantity))
                       from public.sales_breakdown_lines l where l.breakdown_id = b.id and not l.is_base_unit), '[]'::jsonb) as lines
      from public.sales_breakdowns b where b.shop_id = p_shop and b.sales_date = p_date
  ),
  fin as (
    select c.variant_id, c.open_line_id, c.close_line_id, c.status, c.reason, c.units, c.price, c.breakdown,
           k.id as bk_id,
           case when k.id is not null and c.units is not null then public._breakdown_compute(p_shop, c.variant_id, p_date, c.units, k.lines, false) end as chk,
           c.amount as plain_amount
      from calc c left join bk k on k.variant_id = c.variant_id
  ),
  calc2 as (
    select f.variant_id, f.open_line_id, f.close_line_id, f.status, f.reason, f.units, f.price, f.breakdown,
           case when (f.chk->>'ok')::boolean then (f.chk->>'amount')::numeric else f.plain_amount end as amount,
           case when f.bk_id is null then 'unknown'
                when (f.chk->>'ok')::boolean then 'known'
                else 'stale' end as pkg_status
      from fin f
  ),
  old as (select * from public.daily_sales where shop_id = p_shop and sales_date = p_date),
  changed as (
    select c.*, o.id as old_id, o.calculation_status::text as old_status
      from calc2 c left join old o on o.variant_id = c.variant_id
     where o.id is null or (
       o.inferred_base_units_sold, o.estimated_sales_amount, o.price_reference,
       case when o.calculation_status = 'recalculated' then 'calculated' else o.calculation_status::text end,
       o.breakdown, o.pending_reason, o.opening_count_id, o.closing_count_id, o.packaging_status
     ) is distinct from (c.units, c.amount, c.price, c.status, c.breakdown, c.reason, c.open_line_id, c.close_line_id, c.pkg_status)
  ),
  hist as (
    insert into public.daily_sales_revisions (daily_sales_id, shop_id, revision, calculation_status, inferred_base_units_sold,
        estimated_sales_amount, price_reference, breakdown, pending_reason, opening_count_id, closing_count_id, calculated_at, superseded_reason, packaging_status)
    select o.id, o.shop_id, o.calculation_revision, o.calculation_status, o.inferred_base_units_sold, o.estimated_sales_amount,
           o.price_reference, o.breakdown, o.pending_reason, o.opening_count_id, o.closing_count_id, o.calculated_at, p_reason, o.packaging_status
      from public.daily_sales o join changed c on c.old_id = o.id
     where o.calculation_status <> 'pending'   -- a pending placeholder has no figures: replacing it is the FIRST calculation, not a revision
    returning 1
  ),
  up as (
    insert into public.daily_sales (shop_id, variant_id, sales_date, opening_count_id, closing_count_id, inferred_base_units_sold,
        estimated_sales_amount, price_reference, calculation_status, calculation_revision, calculated_at, breakdown, pending_reason, packaging_status)
    select p_shop, c.variant_id, p_date, c.open_line_id, c.close_line_id, c.units, c.amount, c.price,
           (case when c.status = 'calculated' and c.old_id is not null and c.old_status in ('calculated', 'recalculated', 'needs_review')
                 then 'recalculated' else c.status end)::public.sales_calc_status,
           1, now(), c.breakdown, c.reason, c.pkg_status
      from changed c
    on conflict (shop_id, variant_id, sales_date) do update set
      opening_count_id = excluded.opening_count_id, closing_count_id = excluded.closing_count_id,
      inferred_base_units_sold = excluded.inferred_base_units_sold, estimated_sales_amount = excluded.estimated_sales_amount,
      price_reference = excluded.price_reference, calculation_status = excluded.calculation_status,
      calculation_revision = public.daily_sales.calculation_revision + case when public.daily_sales.calculation_status = 'pending' then 0 else 1 end,
      calculated_at = now(),
      breakdown = excluded.breakdown, pending_reason = excluded.pending_reason, packaging_status = excluded.packaging_status
    returning 1
  )
  select (select count(*) from hist) + (select count(*) from up) into v_n;

  -- keep every recorded breakdown for the day consistent with the figure just calculated (re-check it, or mark it stale)
  perform public._breakdown_refresh(p_shop, p_date, p_reason);
end $$;


-- ---------- 6. storing, refreshing, recording and clearing breakdowns ----------
create function public._breakdown_snapshot(p_breakdown uuid) returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'status', b.status, 'revision', b.revision, 'inferred', b.inferred_base_units, 'packaged', b.packaged_base_units,
    'remainder', b.remainder_base_units, 'amount', b.amount, 'note', b.note,
    'lines', coalesce((select jsonb_agg(jsonb_build_object('unit_id', l.packaging_unit_id, 'is_base_unit', l.is_base_unit, 'name', l.unit_name,
                                                          'quantity', l.quantity, 'base_units', l.base_units, 'unit_price', l.unit_price, 'amount', l.amount)
                                        order by l.is_base_unit, l.base_units desc)
                         from public.sales_breakdown_lines l where l.breakdown_id = b.id), '[]'::jsonb))
    from public.sales_breakdowns b where b.id = p_breakdown
$$;

-- Writes a computed breakdown (already validated by _breakdown_compute) as the current one, replacing its lines.
-- The revision number continues across clears, so it is unique per (shop, variant, date).
create function public._breakdown_store(p_shop uuid, p_variant uuid, p_date date, p_inferred numeric, c jsonb, p_by uuid, p_note text)
returns public.sales_breakdowns language plpgsql security definer set search_path = public as $$
declare
  b public.sales_breakdowns;
  v_rev integer;
begin
  select coalesce(max(revision), 0) + 1 into v_rev from public.sales_breakdown_revisions
   where shop_id = p_shop and variant_id = p_variant and sales_date = p_date;
  insert into public.sales_breakdowns (shop_id, variant_id, sales_date, status, revision, inferred_base_units, packaged_base_units,
                                       remainder_base_units, amount, note, created_by, updated_by)
  values (p_shop, p_variant, p_date, 'active', v_rev, p_inferred, (c->>'packaged')::numeric, (c->>'remainder')::numeric,
          (c->>'amount')::numeric, nullif(btrim(p_note), ''), p_by, p_by)
  on conflict (shop_id, variant_id, sales_date) do update set
    status = 'active', revision = v_rev, inferred_base_units = excluded.inferred_base_units, packaged_base_units = excluded.packaged_base_units,
    remainder_base_units = excluded.remainder_base_units, amount = excluded.amount,
    note = coalesce(excluded.note, public.sales_breakdowns.note), updated_by = coalesce(p_by, public.sales_breakdowns.updated_by), updated_at = now()
  returning * into b;

  delete from public.sales_breakdown_lines where breakdown_id = b.id;
  insert into public.sales_breakdown_lines (breakdown_id, packaging_unit_id, is_base_unit, unit_name, quantity, base_units, unit_price, amount)
  select b.id, nullif(l->>'unit_id', '')::uuid, (l->>'is_base_unit')::boolean, l->>'name', (l->>'quantity')::numeric,
         (l->>'base_units')::numeric, (l->>'unit_price')::numeric, (l->>'amount')::numeric
    from jsonb_array_elements(c->'lines') l;
  return b;
end $$;

-- After a day is recalculated (a count was corrected, a movement recorded or reversed), every breakdown for that day is checked again
-- against the NEW inferred figure. Still fits -> its remainder and amount follow the new figure. No longer fits -> marked stale and kept
-- (never deleted, never silently used): the day then falls back to the plain estimate until the owner confirms or changes it.
create function public._breakdown_refresh(p_shop uuid, p_date date, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
declare
  b public.sales_breakdowns;
  d public.daily_sales;
  c jsonb;
  n public.sales_breakdowns;
begin
  for b in select * from public.sales_breakdowns where shop_id = p_shop and sales_date = p_date loop
    select * into d from public.daily_sales where shop_id = p_shop and variant_id = b.variant_id and sales_date = p_date;
    c := public._breakdown_compute(p_shop, b.variant_id, p_date,
           case when d.calculation_status in ('calculated', 'recalculated') then d.inferred_base_units_sold end,
           coalesce((select jsonb_agg(jsonb_build_object('unit_id', l.packaging_unit_id, 'quantity', l.quantity))
                       from public.sales_breakdown_lines l where l.breakdown_id = b.id and not l.is_base_unit), '[]'::jsonb), false);
    if (c->>'ok')::boolean then
      if b.status = 'active' and b.inferred_base_units = d.inferred_base_units_sold and b.amount = (c->>'amount')::numeric
         and b.packaged_base_units = (c->>'packaged')::numeric then
        continue; -- nothing changed
      end if;
      n := public._breakdown_store(p_shop, b.variant_id, p_date, d.inferred_base_units_sold, c, null, null);
      insert into public.sales_breakdown_revisions (shop_id, variant_id, sales_date, revision, action, snapshot, reason)
      values (p_shop, b.variant_id, p_date, n.revision, case when b.status = 'stale' then 'restored' else 'recalculated' end,
              public._breakdown_snapshot(n.id), p_reason);
    elsif b.status = 'active' then
      update public.sales_breakdowns set status = 'stale', revision = (select coalesce(max(r.revision), b.revision) + 1 from public.sales_breakdown_revisions r
                                                                        where r.shop_id = p_shop and r.variant_id = b.variant_id and r.sales_date = p_date),
             updated_at = now()
       where id = b.id returning * into n;
      insert into public.sales_breakdown_revisions (shop_id, variant_id, sales_date, revision, action, snapshot, reason)
      values (p_shop, b.variant_id, p_date, n.revision, 'marked_stale',
              public._breakdown_snapshot(n.id) || jsonb_build_object('error', c->>'error'), p_reason);
    end if;
  end loop;
end $$;
revoke execute on function public._breakdown_snapshot(uuid), public._breakdown_store(uuid, uuid, date, numeric, jsonb, uuid, text),
  public._breakdown_refresh(uuid, date, text) from public, anon, authenticated;

-- Record (or change) the known sales of whole packages for one product on one sales date. Owners and stock managers only.
-- p_lines = [{"unit_id": "<packaging unit>", "quantity": 4}, ...]. Whole packages only; the rest of the inferred sale is the base unit.
-- Changing an existing breakdown needs a reason and (optionally) the revision the caller saw, so two people cannot overwrite each other.
-- A repeated key returns the original result without recording anything twice. This NEVER changes stock.
create function public.record_sales_breakdown(
  p_shop uuid, p_variant uuid, p_date date, p_lines jsonb, p_reason text, p_key text, p_expected_revision integer default null
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  d public.daily_sales;
  b public.sales_breakdowns;
  n public.sales_breakdowns;
  c jsonb;
  v_prev public.sales_breakdown_revisions;
  v_hash text;
  v_action text;
begin
  if not public.has_shop_role(p_shop, array['owner', 'stock_manager']::public.member_role[]) then raise exception 'FORBIDDEN'; end if;
  if p_key is null or char_length(btrim(p_key)) < 8 then raise exception 'KEY_REQUIRED'; end if;
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' then raise exception 'INVALID_LINE'; end if;

  v_hash := md5(p_variant::text || '|' || p_date::text || '|' || p_lines::text);
  select * into v_prev from public.sales_breakdown_revisions where shop_id = p_shop and idempotency_key = btrim(p_key);
  if found then
    if v_prev.request_hash is distinct from v_hash then raise exception 'IDEMPOTENCY_MISMATCH'; end if;
    return jsonb_build_object('ok', true, 'duplicate', true, 'revision', v_prev.revision);
  end if;

  select * into d from public.daily_sales where shop_id = p_shop and variant_id = p_variant and sales_date = p_date for update;
  if not found or d.calculation_status not in ('calculated', 'recalculated') then raise exception 'NOT_CALCULATED'; end if;

  select * into b from public.sales_breakdowns where shop_id = p_shop and variant_id = p_variant and sales_date = p_date;
  if found then
    if char_length(btrim(coalesce(p_reason, ''))) = 0 then raise exception 'REASON_REQUIRED'; end if;
    if p_expected_revision is not null and b.revision <> p_expected_revision then raise exception 'REVISION_CONFLICT'; end if;
    v_action := 'updated';
  else
    if p_expected_revision is not null then raise exception 'REVISION_CONFLICT'; end if;
    v_action := 'created';
  end if;

  c := public._breakdown_compute(p_shop, p_variant, p_date, d.inferred_base_units_sold, p_lines, true);
  if not (c->>'ok')::boolean then raise exception '%', c->>'error'; end if;

  n := public._breakdown_store(p_shop, p_variant, p_date, d.inferred_base_units_sold, c, auth.uid(), null);
  insert into public.sales_breakdown_revisions (shop_id, variant_id, sales_date, revision, action, snapshot, reason, idempotency_key, request_hash, created_by)
  values (p_shop, p_variant, p_date, n.revision, v_action, public._breakdown_snapshot(n.id), nullif(btrim(p_reason), ''), btrim(p_key), v_hash, auth.uid());
  insert into public.audit_logs (shop_id, user_id, action, entity_type, entity_id, before_data, after_data)
  values (p_shop, auth.uid(), 'sales_breakdown_' || v_action, 'sales_breakdowns', n.id,
          case when b.id is not null then jsonb_build_object('revision', b.revision, 'amount', b.amount, 'packaged', b.packaged_base_units) end,
          jsonb_build_object('revision', n.revision, 'amount', n.amount, 'packaged', n.packaged_base_units, 'sales_date', p_date, 'variant_id', p_variant,
                             'reason', nullif(btrim(p_reason), '')));

  perform public._recalc_sales_day(p_shop, p_date, 'breakdown_saved');
  return jsonb_build_object('ok', true, 'duplicate', false, 'revision', n.revision, 'amount', n.amount);
end $$;
revoke execute on function public.record_sales_breakdown(uuid, uuid, date, jsonb, text, text, integer) from public, anon;
grant execute on function public.record_sales_breakdown(uuid, uuid, date, jsonb, text, text, integer) to authenticated;

-- "I do not know the box sales after all": removes the breakdown (its history stays) and the day returns to the plain estimate.
create function public.clear_sales_breakdown(p_shop uuid, p_variant uuid, p_date date, p_reason text, p_key text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  b public.sales_breakdowns;
  v_prev public.sales_breakdown_revisions;
  v_rev integer;
  v_hash text;
begin
  if not public.has_shop_role(p_shop, array['owner', 'stock_manager']::public.member_role[]) then raise exception 'FORBIDDEN'; end if;
  if p_key is null or char_length(btrim(p_key)) < 8 then raise exception 'KEY_REQUIRED'; end if;
  if char_length(btrim(coalesce(p_reason, ''))) = 0 then raise exception 'REASON_REQUIRED'; end if;

  v_hash := md5('clear|' || p_variant::text || '|' || p_date::text);
  select * into v_prev from public.sales_breakdown_revisions where shop_id = p_shop and idempotency_key = btrim(p_key);
  if found then
    if v_prev.request_hash is distinct from v_hash then raise exception 'IDEMPOTENCY_MISMATCH'; end if;
    return jsonb_build_object('ok', true, 'duplicate', true, 'revision', v_prev.revision);
  end if;

  select * into b from public.sales_breakdowns where shop_id = p_shop and variant_id = p_variant and sales_date = p_date for update;
  if not found then raise exception 'NOT_FOUND'; end if;
  select coalesce(max(revision), b.revision) + 1 into v_rev from public.sales_breakdown_revisions
   where shop_id = p_shop and variant_id = p_variant and sales_date = p_date;

  insert into public.sales_breakdown_revisions (shop_id, variant_id, sales_date, revision, action, snapshot, reason, idempotency_key, request_hash, created_by)
  values (p_shop, p_variant, p_date, v_rev, 'cleared', null, btrim(p_reason), btrim(p_key), v_hash, auth.uid());
  insert into public.audit_logs (shop_id, user_id, action, entity_type, entity_id, before_data, after_data)
  values (p_shop, auth.uid(), 'sales_breakdown_cleared', 'sales_breakdowns', b.id, public._breakdown_snapshot(b.id),
          jsonb_build_object('sales_date', p_date, 'variant_id', p_variant, 'reason', btrim(p_reason)));
  delete from public.sales_breakdowns where id = b.id;   -- its lines go with it; the revisions above keep the history

  perform public._recalc_sales_day(p_shop, p_date, 'breakdown_cleared');
  return jsonb_build_object('ok', true, 'duplicate', false, 'revision', v_rev);
end $$;
revoke execute on function public.clear_sales_breakdown(uuid, uuid, date, text, text) from public, anon;
grant execute on function public.clear_sales_breakdown(uuid, uuid, date, text, text) to authenticated;

-- ---------- 7. reporting: what is KNOWN, what is estimated, what has no packaging at all ----------
-- bucket: 'known'    a packaging breakdown was recorded, so the revenue uses the package prices
--         'unknown'  the product CAN be sold in packages but no breakdown was recorded: an estimate at the base-unit price
--         'standard' the product has no sellable packaging: the ordinary estimate (units x price)
-- Only calculated days are listed; needs-review and pending days have no figure.
create function public.monthly_packaging_report(p_shop uuid, p_month text)
returns table (sales_date date, variant_id uuid, product_name text, sku text, base_unit text, units_sold numeric, estimated_amount numeric,
               bucket text, packaging_status text, lines jsonb)
language plpgsql stable security invoker set search_path = public as $$
#variable_conflict use_column
declare v_start date; v_next date;
begin
  if p_month !~ '^\d{4}-(0[1-9]|1[0-2])$' then raise exception 'INVALID_MONTH'; end if;
  v_start := (p_month || '-01')::date;
  v_next := (v_start + interval '1 month')::date;
  return query
  select d.sales_date, d.variant_id, p.name, v.sku, v.base_inventory_unit, d.inferred_base_units_sold, d.estimated_sales_amount,
         case when d.packaging_status = 'known' then 'known'
              when exists (select 1 from public.packaging_units pu where pu.variant_id = v.id and pu.can_be_sold and pu.is_active) then 'unknown'
              else 'standard' end,
         d.packaging_status,
         case when d.packaging_status = 'known' then
           (select jsonb_agg(jsonb_build_object('name', l.unit_name, 'is_base_unit', l.is_base_unit, 'quantity', l.quantity, 'base_units', l.base_units,
                                                'unit_price', l.unit_price, 'amount', l.amount) order by l.is_base_unit, l.base_units desc)
              from public.sales_breakdowns b join public.sales_breakdown_lines l on l.breakdown_id = b.id
             where b.shop_id = d.shop_id and b.variant_id = d.variant_id and b.sales_date = d.sales_date) end
    from public.daily_sales d
    join public.product_variants v on v.id = d.variant_id
    join public.products p on p.id = v.product_id
   where d.shop_id = p_shop and d.sales_date >= v_start and d.sales_date < v_next and d.calculation_status in ('calculated', 'recalculated')
   order by d.sales_date, p.name, v.sku;
end $$;
revoke execute on function public.monthly_packaging_report(uuid, text) from public, anon;
grant execute on function public.monthly_packaging_report(uuid, text) to authenticated;
