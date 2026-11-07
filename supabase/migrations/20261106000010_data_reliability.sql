-- Phase 9: data reliability + performance.
--   * data_health_check: owner-run integrity audit (structure + "would a recalculation change any stored sales figure?")
--   * repair_sales:      owner-run recalculation of stored sales from the confirmed counts and movements, with history
--   * record_backup_export: audit trail for full-data downloads
--   * indexes for the access patterns that grow with the catalog and with time

-- ---------- indexes ----------
-- stock_count_lines is the biggest table (products x mornings); the FK to variants was unindexed.
create index if not exists count_lines_variant_idx on public.stock_count_lines (variant_id);
-- (a per-product sales index is not needed: unique (shop_id, variant_id, sales_date) already serves those reads)
-- the movement list, report windows and reconciliation filter by shop and time
create index if not exists movements_shop_time_idx on public.stock_movements (shop_id, effective_at desc);
-- "latest confirmed count before X" is asked constantly (previous count, reconciliation, dashboard)
create index if not exists sessions_shop_status_date_idx on public.stock_count_sessions (shop_id, status, business_date desc);
-- audit viewer filters by action
create index if not exists audit_shop_action_idx on public.audit_logs (shop_id, action, created_at desc);
-- price lookup at an instant: variant + type, newest first
create index if not exists price_history_lookup_idx on public.product_price_history (variant_id, price_type, effective_from desc);

-- ---------- internal: a fingerprint of the stored sales figures ----------
create function public._sales_fingerprint(p_shop uuid, p_from date) returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_object_agg(d.id::text, md5(concat_ws('|',
           d.inferred_base_units_sold, d.estimated_sales_amount, d.price_reference,
           case when d.calculation_status = 'recalculated' then 'calculated' else d.calculation_status::text end,
           d.pending_reason, d.opening_count_id, d.closing_count_id))), '{}'::jsonb)
    from public.daily_sales d
   where d.shop_id = p_shop and d.sales_date >= p_from;
$$;
create function public._sales_changed_since(p_shop uuid, p_from date, p_before jsonb) returns integer
language sql stable security definer set search_path = public as $$
  select count(*)::integer
    from jsonb_each_text(public._sales_fingerprint(p_shop, p_from)) a
   where (p_before ->> a.key) is distinct from a.value;
$$;
revoke execute on function public._sales_fingerprint(uuid, date), public._sales_changed_since(uuid, date, jsonb) from public, anon, authenticated;

-- ---------- data health check ----------
create function public.data_health_check(p_shop uuid, p_days integer default 90)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_from date;
  v_before jsonb;
  v_drift integer := 0;
  v_checks jsonb;
begin
  if not public.has_shop_role(p_shop, array['owner']::public.member_role[]) then raise exception 'FORBIDDEN'; end if;
  if p_days is null or p_days < 1 or p_days > 366 then raise exception 'INVALID_RANGE'; end if;
  v_from := current_date - p_days;

  with c(key, severity, ids) as (
    -- a confirmed count with no lines can never produce a sale
    select 'confirmed_count_without_lines', 'error', array_agg(s.id)
      from public.stock_count_sessions s
     where s.shop_id = p_shop and s.status in ('confirmed', 'corrected')
       and not exists (select 1 from public.stock_count_lines l where l.session_id = s.id)
    union all
    select 'confirmed_count_missing_confirmer', 'error', array_agg(s.id)
      from public.stock_count_sessions s
     where s.shop_id = p_shop and s.status in ('confirmed', 'corrected') and (s.confirmed_by is null or s.confirmed_at is null)
    union all
    select 'count_line_from_other_shop', 'error', array_agg(l.id)
      from public.stock_count_lines l
      join public.stock_count_sessions s on s.id = l.session_id
      join public.product_variants v on v.id = l.variant_id
     where s.shop_id = p_shop and v.shop_id <> s.shop_id
    union all
    select 'movement_for_other_shop_variant', 'error', array_agg(m.id)
      from public.stock_movements m
      join public.product_variants v on v.id = m.variant_id
     where m.shop_id = p_shop and v.shop_id <> m.shop_id
    union all
    -- a sales row must point at the opening count of its own day and the closing count of the next
    select 'sales_linked_to_wrong_count', 'error', array_agg(d.id)
      from public.daily_sales d
      left join public.stock_count_lines lo on lo.id = d.opening_count_id
      left join public.stock_count_sessions so on so.id = lo.session_id
      left join public.stock_count_lines lc on lc.id = d.closing_count_id
      left join public.stock_count_sessions sc on sc.id = lc.session_id
     where d.shop_id = p_shop and d.sales_date >= v_from
       and ((d.opening_count_id is not null and so.business_date is distinct from d.sales_date)
         or (d.closing_count_id is not null and sc.business_date is distinct from d.sales_date + 1))
    union all
    select 'calculated_sale_without_valid_figure', 'error', array_agg(d.id)
      from public.daily_sales d
     where d.shop_id = p_shop and d.sales_date >= v_from
       and d.calculation_status in ('calculated', 'recalculated')
       and (d.inferred_base_units_sold is null or d.inferred_base_units_sold < 0)
    union all
    -- two consecutive confirmed mornings, but no sales rows for products on the earlier count: reconciliation never ran
    select 'confirmed_days_without_sales_rows', 'error', array_agg(distinct s.id)
      from public.stock_count_sessions s
      join public.stock_count_sessions s2 on s2.shop_id = s.shop_id and s2.business_date = s.business_date + 1 and s2.status in ('confirmed', 'corrected')
      join public.stock_count_lines l on l.session_id = s.id
     where s.shop_id = p_shop and s.status in ('confirmed', 'corrected') and s.business_date >= v_from
       and not exists (select 1 from public.daily_sales d where d.shop_id = s.shop_id and d.variant_id = l.variant_id and d.sales_date = s.business_date)
    union all
    -- not corruption, but sales for these products cannot be valued
    select 'active_products_without_selling_price', 'warning', array_agg(v.id)
      from public.product_variants v
      join public.products p on p.id = v.product_id
     where v.shop_id = p_shop and v.is_active and p.is_active
       and not exists (select 1 from public.product_price_history h
                        where h.variant_id = v.id and h.price_type = 'selling' and h.effective_to is null)
    union all
    select 'old_unconfirmed_drafts', 'warning', array_agg(s.id)
      from public.stock_count_sessions s
     where s.shop_id = p_shop and s.status in ('draft', 'needs_review') and s.counted_at < now() - interval '3 days'
  )
  select jsonb_agg(jsonb_build_object(
           'key', key, 'severity', severity,
           'count', coalesce(cardinality(ids), 0),
           'sample', coalesce(to_jsonb(ids[1:5]), '[]'::jsonb))
         order by (severity = 'error') desc, key)
    into v_checks from c;

  -- Would a fresh recalculation change any stored figure? Run it, count the differences, then roll it back.
  begin
    v_before := public._sales_fingerprint(p_shop, v_from);
    perform public._recalc_range(p_shop, v_from, current_date, 'health_check');
    v_drift := public._sales_changed_since(p_shop, v_from, v_before);
    raise exception 'DRYRUN';
  exception when raise_exception then
    if sqlerrm <> 'DRYRUN' then raise; end if;   -- real failures must surface; only our own rollback is swallowed
  end;
  v_checks := v_checks || jsonb_build_array(jsonb_build_object(
    'key', 'stored_sales_differ_from_recalculation', 'severity', 'error', 'count', v_drift, 'sample', '[]'::jsonb));

  return jsonb_build_object(
    'checked_at', now(), 'from', v_from, 'days', p_days,
    'errors', (select count(*) from jsonb_array_elements(v_checks) e where e ->> 'severity' = 'error' and (e ->> 'count')::int > 0),
    'warnings', (select count(*) from jsonb_array_elements(v_checks) e where e ->> 'severity' = 'warning' and (e ->> 'count')::int > 0),
    'checks', v_checks);
end $$;

-- ---------- repair ----------
create function public.repair_sales(p_shop uuid, p_days integer default 90)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_from date;
  v_before jsonb;
  v_changed integer;
begin
  if not public.has_shop_role(p_shop, array['owner']::public.member_role[]) then raise exception 'FORBIDDEN'; end if;
  if p_days is null or p_days < 1 or p_days > 366 then raise exception 'INVALID_RANGE'; end if;
  v_from := current_date - p_days;
  v_before := public._sales_fingerprint(p_shop, v_from);
  perform public._recalc_range(p_shop, v_from, current_date, 'data_repair');   -- keeps history for anything it changes
  v_changed := public._sales_changed_since(p_shop, v_from, v_before);
  insert into public.audit_logs (shop_id, user_id, action, entity_type, after_data)
  values (p_shop, auth.uid(), 'repair_sales', 'daily_sales', jsonb_build_object('from', v_from, 'rows_changed', v_changed));
  return jsonb_build_object('from', v_from, 'changed', v_changed);
end $$;

-- ---------- backup audit ----------
create function public.record_backup_export(p_shop uuid, p_counts jsonb, p_checksum text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.has_shop_role(p_shop, array['owner']::public.member_role[]) then raise exception 'FORBIDDEN'; end if;
  insert into public.audit_logs (shop_id, user_id, action, entity_type, after_data)
  values (p_shop, auth.uid(), 'export_backup', 'shops', jsonb_build_object('rows', p_counts, 'checksum', p_checksum));
end $$;

revoke execute on function public.data_health_check(uuid, integer), public.repair_sales(uuid, integer),
  public.record_backup_export(uuid, jsonb, text) from public, anon;
grant execute on function public.data_health_check(uuid, integer), public.repair_sales(uuid, integer),
  public.record_backup_export(uuid, jsonb, text) to authenticated;
