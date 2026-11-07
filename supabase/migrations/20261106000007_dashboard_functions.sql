-- Phase 6: dashboard aggregates.
-- All functions are SECURITY INVOKER: they run as the caller, so Row Level Security still applies
-- (a user passing someone else's shop id simply gets no rows). They only read; nothing here writes.
--
-- Money is additive across products; QUANTITIES ARE NOT (packets and bottles are different units),
-- so units are always grouped by the variant's base unit and never summed across units.

-- Covering index for date-range summaries (keeps month/year scans index-only for large catalogs).
create index if not exists daily_sales_summary_idx on public.daily_sales (shop_id, sales_date)
  include (variant_id, calculation_status, inferred_base_units_sold, estimated_sales_amount);

-- ---------- sales_daily_summary: per day and per base unit ----------
create function public.sales_daily_summary(p_shop uuid, p_from date, p_to date)
returns table (sales_date date, base_unit text, units_sold numeric, estimated_amount numeric,
               calculated_count integer, needs_review_count integer, pending_count integer)
language plpgsql stable security invoker set search_path = public as $$
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
   where d.shop_id = p_shop and d.sales_date between p_from and p_to
   group by d.sales_date, v.base_inventory_unit
   order by d.sales_date, v.base_inventory_unit;
end $$;

-- ---------- sales_top_products: ranked by Estimated Sales (additive), then units ----------
create function public.sales_top_products(p_shop uuid, p_from date, p_to date, p_limit integer default 5)
returns table (variant_id uuid, product_name text, sku text, size_value numeric, size_unit text, base_unit text,
               units_sold numeric, estimated_amount numeric)
language plpgsql stable security invoker set search_path = public as $$
begin
  if p_to - p_from > 400 then raise exception 'RANGE_TOO_LARGE'; end if;
  return query
  select v.id, p.name, v.sku, v.size_value, v.size_unit, v.base_inventory_unit,
         sum(d.inferred_base_units_sold), coalesce(sum(d.estimated_sales_amount), 0)
    from public.daily_sales d
    join public.product_variants v on v.id = d.variant_id
    join public.products p on p.id = v.product_id
   where d.shop_id = p_shop and d.sales_date between p_from and p_to
     and d.calculation_status in ('calculated', 'recalculated')
   group by v.id, p.name, v.sku, v.size_value, v.size_unit, v.base_inventory_unit
  having sum(d.inferred_base_units_sold) > 0
   order by coalesce(sum(d.estimated_sales_amount), 0) desc, sum(d.inferred_base_units_sold) desc, v.sku
   limit least(greatest(p_limit, 1), 50);
end $$;

-- ---------- stock_valuation: the LATEST confirmed count, valued at purchase cost ----------
-- Policy (documented, explicit): cost in force at the moment that count was taken. This is the value of what was
-- physically on the shelf that morning at COST (not retail). It is never a sum of several mornings' balances.
-- Products with no cost on record are counted in `uncosted` and contribute nothing (so the figure is a floor).
create function public.stock_valuation(p_shop uuid)
returns table (session_id uuid, as_of date, counted_at timestamptz, total_cost numeric,
               valued_count integer, uncosted_count integer, counted_total integer)
language sql stable security invoker set search_path = public as $$
  with s as (
    select id, business_date, counted_at from public.stock_count_sessions
     where shop_id = p_shop and status in ('confirmed', 'corrected')
     order by business_date desc limit 1
  ),
  c as (
    select l.normalized_base_quantity as q,
           (select h.amount_lkr from public.product_price_history h
             where h.variant_id = l.variant_id and h.price_type = 'purchase_cost'
               and h.effective_from <= s.counted_at and (h.effective_to is null or h.effective_to > s.counted_at)
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

-- ---------- low_stock_items: latest confirmed count vs each product's threshold ----------
-- quantity <= threshold. With the default threshold 0 this means "out of stock". Products not counted in the
-- latest count are unknown, not low. Inactive products are ignored. Most urgent first (out of stock, then lowest ratio).
create function public.low_stock_items(p_shop uuid, p_limit integer default 6)
returns table (variant_id uuid, product_name text, sku text, size_value numeric, size_unit text, base_unit text,
               quantity numeric, threshold numeric, total_low integer)
language sql stable security invoker set search_path = public as $$
  with s as (
    select id from public.stock_count_sessions
     where shop_id = p_shop and status in ('confirmed', 'corrected')
     order by business_date desc limit 1
  ),
  q as (
    select v.id as vid, p.name as pname, v.sku, v.size_value, v.size_unit, v.base_inventory_unit as bu,
           l.normalized_base_quantity as qty, v.low_stock_threshold as th
      from public.stock_count_lines l
      join s on s.id = l.session_id
      join public.product_variants v on v.id = l.variant_id
      join public.products p on p.id = v.product_id
     where l.count_status = 'counted' and v.shop_id = p_shop and v.is_active and p.is_active
       and l.normalized_base_quantity <= v.low_stock_threshold
  )
  select vid, pname, sku, size_value, size_unit, bu, qty, th, (count(*) over ())::integer
    from q
   order by (qty = 0) desc, qty / nullif(th, 0) nulls first, pname, sku
   limit least(greatest(p_limit, 1), 50);
$$;

revoke execute on function public.sales_daily_summary(uuid, date, date), public.sales_top_products(uuid, date, date, integer),
  public.stock_valuation(uuid), public.low_stock_items(uuid, integer) from public, anon;
grant execute on function public.sales_daily_summary(uuid, date, date), public.sales_top_products(uuid, date, date, integer),
  public.stock_valuation(uuid), public.low_stock_items(uuid, integer) to authenticated;
