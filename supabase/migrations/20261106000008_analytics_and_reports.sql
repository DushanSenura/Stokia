-- Phase 7: analytics + monthly reports.
-- Read-only SECURITY INVOKER functions (Row Level Security applies; a foreign shop id returns nothing).
-- Money is additive across products; quantities are returned per variant / per base unit and are never summed across units.
--
-- MONTH BOUNDARY RULE: a month's sales run to its LAST day, and that day is calculated by the NEXT month's first count.
--   opening stock  = the count on the 1st of the month        (what the previous month closed with)
--   closing stock  = the count on the 1st of the NEXT month   (so the month is incomplete until it exists)
--   movements      = those with  counted_at(opening) < effective_at <= counted_at(closing)
-- Stock is never "summed over mornings": only the opening and closing counts are used for stock quantities.

-- ---------- export log ----------
create table public.report_exports (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops (id) on delete cascade,
  report_month text not null check (report_month ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  format text not null check (format in ('pdf', 'xlsx', 'csv', 'print')),
  fingerprint text not null,           -- data version at export time: a different value later means "changed since export"
  totals jsonb,
  exported_by uuid not null references auth.users (id),
  exported_at timestamptz not null default now()
);
create index report_exports_month_idx on public.report_exports (shop_id, report_month, exported_at desc);
alter table public.report_exports enable row level security;
create policy report_exports_select on public.report_exports for select to authenticated using (public.is_shop_member(shop_id));
revoke all on public.report_exports from anon;
revoke insert, update, delete on public.report_exports from authenticated;

create function public.record_report_export(p_shop uuid, p_month text, p_format text, p_fingerprint text, p_totals jsonb)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  -- any active member may export (viewers have read access to reports); the record is the audit trail
  if not public.is_shop_member(p_shop) then raise exception 'FORBIDDEN'; end if;
  insert into public.report_exports (shop_id, report_month, format, fingerprint, totals, exported_by)
  values (p_shop, p_month, p_format, p_fingerprint, p_totals, auth.uid()) returning id into v_id;
  insert into public.audit_logs (shop_id, user_id, action, entity_type, entity_id, after_data)
  values (p_shop, auth.uid(), 'export_report', 'report_exports', v_id, jsonb_build_object('month', p_month, 'format', p_format));
  return v_id;
end $$;
revoke execute on function public.record_report_export(uuid, text, text, text, jsonb) from public, anon;
grant execute on function public.record_report_export(uuid, text, text, text, jsonb) to authenticated;

-- ---------- analytics: per-variant summary (zero-sales variants included so slow movers are visible) ----------
create function public.analytics_variant_summary(
  p_shop uuid, p_from date, p_to date, p_category uuid default null, p_product uuid default null, p_variant uuid default null)
returns table (variant_id uuid, product_id uuid, product_name text, category_id uuid, category_name text, sku text,
               size_value numeric, size_unit text, base_unit text, units_sold numeric, estimated_amount numeric,
               days_calculated integer, days_review integer, days_pending integer)
language plpgsql stable security invoker set search_path = public as $$
#variable_conflict use_column
begin
  if p_to - p_from > 400 then raise exception 'RANGE_TOO_LARGE'; end if;
  return query
  select v.id, p.id, p.name, c.id, c.name, v.sku, v.size_value, v.size_unit, v.base_inventory_unit,
         coalesce(s.units, 0), coalesce(s.amount, 0), coalesce(s.dc, 0), coalesce(s.dr, 0), coalesce(s.dp, 0)
    from public.product_variants v
    join public.products p on p.id = v.product_id
    left join public.categories c on c.id = p.category_id
    left join lateral (
      select sum(d.inferred_base_units_sold) filter (where d.calculation_status in ('calculated', 'recalculated')) as units,
             sum(d.estimated_sales_amount) filter (where d.calculation_status in ('calculated', 'recalculated')) as amount,
             (count(*) filter (where d.calculation_status in ('calculated', 'recalculated')))::integer as dc,
             (count(*) filter (where d.calculation_status = 'needs_review'))::integer as dr,
             (count(*) filter (where d.calculation_status = 'pending'))::integer as dp,
             count(*) as n
        from public.daily_sales d
       where d.shop_id = p_shop and d.variant_id = v.id and d.sales_date between p_from and p_to) s on true
   where v.shop_id = p_shop
     and (p_category is null or p.category_id = p_category)
     and (p_product is null or p.id = p_product)
     and (p_variant is null or v.id = p_variant)
     and ((v.is_active and p.is_active) or coalesce(s.n, 0) > 0)
   order by coalesce(s.amount, 0) desc, coalesce(s.units, 0) desc, p.name, v.sku;
end $$;

-- ---------- analytics: filtered daily summary (per day and base unit) ----------
create function public.analytics_daily(
  p_shop uuid, p_from date, p_to date, p_category uuid default null, p_product uuid default null, p_variant uuid default null)
returns table (sales_date date, base_unit text, units_sold numeric, estimated_amount numeric,
               calculated_count integer, needs_review_count integer, pending_count integer)
language plpgsql stable security invoker set search_path = public as $$
#variable_conflict use_column
begin
  if p_to - p_from > 400 then raise exception 'RANGE_TOO_LARGE'; end if;
  return query
  select d.sales_date, v.base_inventory_unit,
         coalesce(sum(d.inferred_base_units_sold) filter (where d.calculation_status in ('calculated', 'recalculated')), 0),
         coalesce(sum(d.estimated_sales_amount) filter (where d.calculation_status in ('calculated', 'recalculated')), 0),
         (count(*) filter (where d.calculation_status in ('calculated', 'recalculated')))::integer,
         (count(*) filter (where d.calculation_status = 'needs_review'))::integer,
         (count(*) filter (where d.calculation_status = 'pending'))::integer
    from public.daily_sales d
    join public.product_variants v on v.id = d.variant_id
    join public.products p on p.id = v.product_id
   where d.shop_id = p_shop and d.sales_date between p_from and p_to
     and (p_category is null or p.category_id = p_category)
     and (p_product is null or p.id = p_product)
     and (p_variant is null or v.id = p_variant)
   group by d.sales_date, v.base_inventory_unit
   order by d.sales_date, v.base_inventory_unit;
end $$;

-- ---------- analytics: movement trend (shop-local days, per base unit) ----------
create function public.analytics_movement_trend(
  p_shop uuid, p_from date, p_to date, p_category uuid default null, p_product uuid default null, p_variant uuid default null)
returns table (day date, base_unit text, received numeric, returned_in numeric, damaged_out numeric, other_out numeric,
               adjustments numeric, movement_count integer)
language plpgsql stable security invoker set search_path = public as $$
#variable_conflict use_column
declare v_tz text;
begin
  if p_to - p_from > 400 then raise exception 'RANGE_TOO_LARGE'; end if;
  select timezone into v_tz from public.shops where id = p_shop;
  return query
  select (m.effective_at at time zone v_tz)::date as day, v.base_inventory_unit,
         coalesce(sum(m.normalized_base_quantity) filter (where m.type = 'stock_received'), 0),
         coalesce(sum(m.normalized_base_quantity) filter (where m.type = 'customer_return'), 0),
         -coalesce(sum(m.normalized_base_quantity) filter (where m.type in ('damaged', 'expired', 'discarded')), 0),
         -coalesce(sum(m.normalized_base_quantity) filter (where m.type = 'supplier_return'), 0),
         coalesce(sum(m.normalized_base_quantity) filter (where m.type in ('manual_adjustment', 'repacking')), 0),
         count(*)::integer
    from public.stock_movements m
    join public.product_variants v on v.id = m.variant_id
    join public.products p on p.id = v.product_id
   where m.shop_id = p_shop
     and m.effective_at >= (p_from::timestamp at time zone v_tz)
     and m.effective_at < ((p_to + 1)::timestamp at time zone v_tz)
     and (p_category is null or p.category_id = p_category)
     and (p_product is null or p.id = p_product)
     and (p_variant is null or v.id = p_variant)
   group by 1, v.base_inventory_unit
   order by 1, v.base_inventory_unit;
end $$;

-- ---------- monthly report: one row per variant ----------
create function public.monthly_report_variants(p_shop uuid, p_month text)
returns table (variant_id uuid, product_id uuid, product_name text, product_code text, category_id uuid, category_name text,
               sku text, size_value numeric, size_unit text, base_unit text, is_active boolean,
               opening numeric, closing numeric, received numeric, returned_in numeric, damaged_out numeric, other_out numeric,
               adjustments numeric, units_sold numeric, estimated_amount numeric,
               days_calculated integer, days_review integer, days_pending integer, max_revision integer,
               closing_cost numeric, closing_value numeric)
language plpgsql stable security invoker set search_path = public as $$
#variable_conflict use_column
declare
  v_start date; v_next date; v_tz text;
  os uuid; cs uuid; o_at timestamptz; c_at timestamptz; lo timestamptz; hi timestamptz;
begin
  if p_month !~ '^\d{4}-(0[1-9]|1[0-2])$' then raise exception 'INVALID_MONTH'; end if;
  v_start := (p_month || '-01')::date;
  v_next := (v_start + interval '1 month')::date;
  select timezone into v_tz from public.shops where id = p_shop;
  select id, counted_at into os, o_at from public.stock_count_sessions
   where shop_id = p_shop and business_date = v_start and status in ('confirmed', 'corrected');
  select id, counted_at into cs, c_at from public.stock_count_sessions
   where shop_id = p_shop and business_date = v_next and status in ('confirmed', 'corrected');
  -- Without a count the window falls back to the calendar month (the report is then flagged incomplete by its status).
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
         and h.effective_from <= c_at and (h.effective_to is null or h.effective_to > c_at)
       limit 1) cost on true
   where v.shop_id = p_shop
     and ((v.is_active and p.is_active) or coalesce(s.n, 0) > 0 or lo_.id is not null or lc_.id is not null)
   order by p.name, v.sku;
end $$;

-- ---------- data version of a month: changes whenever any figure in the report could have changed ----------
create function public.monthly_report_fingerprint(p_shop uuid, p_month text) returns text
language plpgsql stable security invoker set search_path = public as $$
declare
  v_start date; v_next date; os uuid; cs uuid; o_at timestamptz; c_at timestamptz; lo timestamptz; hi timestamptz; v_tz text;
  v_sales text; v_mv text;
begin
  if p_month !~ '^\d{4}-(0[1-9]|1[0-2])$' then raise exception 'INVALID_MONTH'; end if;
  v_start := (p_month || '-01')::date;
  v_next := (v_start + interval '1 month')::date;
  select timezone into v_tz from public.shops where id = p_shop;
  select id, counted_at into os, o_at from public.stock_count_sessions where shop_id = p_shop and business_date = v_start and status in ('confirmed', 'corrected');
  select id, counted_at into cs, c_at from public.stock_count_sessions where shop_id = p_shop and business_date = v_next and status in ('confirmed', 'corrected');
  lo := coalesce(o_at, v_start::timestamp at time zone v_tz);
  hi := coalesce(c_at, least(now(), v_next::timestamp at time zone v_tz));
  select coalesce(string_agg(d.id::text || ':' || d.calculation_revision::text, ',' order by d.id), '') into v_sales
    from public.daily_sales d where d.shop_id = p_shop and d.sales_date >= v_start and d.sales_date < v_next;
  select count(*)::text || ':' || coalesce(sum(m.normalized_base_quantity), 0)::text into v_mv
    from public.stock_movements m where m.shop_id = p_shop and m.effective_at > lo and m.effective_at <= hi;
  return md5(concat_ws('|', v_sales, v_mv, coalesce(os::text, '-'), coalesce(cs::text, '-')));
end $$;

revoke execute on function public.analytics_variant_summary(uuid, date, date, uuid, uuid, uuid), public.analytics_daily(uuid, date, date, uuid, uuid, uuid),
  public.analytics_movement_trend(uuid, date, date, uuid, uuid, uuid), public.monthly_report_variants(uuid, text),
  public.monthly_report_fingerprint(uuid, text) from public, anon;
grant execute on function public.analytics_variant_summary(uuid, date, date, uuid, uuid, uuid), public.analytics_daily(uuid, date, date, uuid, uuid, uuid),
  public.analytics_movement_trend(uuid, date, date, uuid, uuid, uuid), public.monthly_report_variants(uuid, text),
  public.monthly_report_fingerprint(uuid, text) to authenticated;
