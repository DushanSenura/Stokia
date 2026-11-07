-- Phase 4: morning stock counts — draft save, confirm, discard.
-- All three are SECURITY DEFINER with explicit role checks, so confirmed counts stay immutable to
-- API clients (RLS only lets drafts be edited) while the workflow remains atomic and retry-safe.
--
-- Business rules enforced here:
--   * one session per shop per business date (unique constraint);
--   * a count can't be dated in the future (shop-local date) nor before/at an already confirmed count;
--   * optimistic concurrency via `revision`;
--   * confirm is idempotent (a retry of a successful confirm returns success, never double-applies);
--   * on confirm every active variant gets a line: counted, or explicitly NOT counted (never zero).

-- Audit session changes only when the status changes (draft autosaves would otherwise flood the log).
drop trigger if exists audit_sessions on public.stock_count_sessions;
create trigger audit_sessions_insert after insert on public.stock_count_sessions
  for each row execute function public.audit_row_change();
create trigger audit_sessions_status after update on public.stock_count_sessions
  for each row when (old.status is distinct from new.status) execute function public.audit_row_change();

-- ---------- save_count_draft ----------
-- p_lines: COMPLETE set of counted lines: [{variant_id, normalized_base_quantity, entry_details}]
-- p_revision: NULL when no session exists yet, otherwise the revision the client last saw.
create function public.save_count_draft(p_shop uuid, p_date date, p_lines jsonb, p_revision integer)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_tz text;
  v_today date;
  s public.stock_count_sessions;
  l jsonb;
  v_ids uuid[] := '{}';
  v_vid uuid;
begin
  if not public.has_shop_role(p_shop, array['owner','stock_manager']::public.member_role[]) then raise exception 'FORBIDDEN'; end if;
  if jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) > 5000 then raise exception 'INVALID_PAYLOAD'; end if;

  select timezone into v_tz from public.shops where id = p_shop;
  v_today := (now() at time zone v_tz)::date;
  if p_date > v_today then raise exception 'FUTURE_DATE'; end if;

  select * into s from public.stock_count_sessions where shop_id = p_shop and business_date = p_date for update;
  if found then
    if s.status <> 'draft' then raise exception 'ALREADY_CONFIRMED'; end if;
    if p_revision is distinct from s.revision then raise exception 'REVISION_CONFLICT'; end if;
  else
    if p_revision is not null then raise exception 'REVISION_CONFLICT'; end if;
    -- Counts must be entered in order: backfilling before a confirmed count would rewrite its interval.
    if exists (select 1 from public.stock_count_sessions where shop_id = p_shop and status <> 'draft' and business_date >= p_date) then
      raise exception 'COUNT_OUT_OF_ORDER';
    end if;
    insert into public.stock_count_sessions (shop_id, business_date, created_by)
    values (p_shop, p_date, auth.uid()) returning * into s;
  end if;

  for l in select * from jsonb_array_elements(p_lines) loop
    v_vid := (l->>'variant_id')::uuid;
    if v_vid = any (v_ids) then raise exception 'DUPLICATE_LINE'; end if;
    if not exists (select 1 from public.product_variants v join public.products p on p.id = v.product_id
                   where v.id = v_vid and v.shop_id = p_shop and v.is_active and p.is_active) then
      raise exception 'INVALID_VARIANT';
    end if;
    v_ids := v_ids || v_vid;
    insert into public.stock_count_lines (session_id, variant_id, normalized_base_quantity, entry_details, count_status)
    values (s.id, v_vid, (l->>'normalized_base_quantity')::numeric, coalesce(l->'entry_details', '{}'::jsonb), 'counted')
    on conflict (session_id, variant_id) do update
      set normalized_base_quantity = excluded.normalized_base_quantity, entry_details = excluded.entry_details, count_status = 'counted';
  end loop;

  -- Lines the user cleared are removed: blank means "not counted".
  delete from public.stock_count_lines where session_id = s.id and not (variant_id = any (v_ids));

  update public.stock_count_sessions set revision = revision + 1 where id = s.id returning * into s;
  return jsonb_build_object('session_id', s.id, 'revision', s.revision, 'counted', coalesce(array_length(v_ids, 1), 0));
end $$;

-- ---------- confirm_count ----------
create function public.confirm_count(p_session uuid, p_revision integer, p_ack_missing boolean default false)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  s public.stock_count_sessions;
  v_counted int;
  v_missing int;
begin
  select * into s from public.stock_count_sessions where id = p_session for update;
  if not found then raise exception 'NOT_FOUND'; end if;
  if not public.has_shop_role(s.shop_id, array['owner','stock_manager']::public.member_role[]) then raise exception 'FORBIDDEN'; end if;

  -- Idempotent: a retried/duplicate confirm of an already confirmed count is a harmless success.
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

  -- Record uncounted products explicitly (NULL quantity, never zero) so "not counted" is part of the record.
  insert into public.stock_count_lines (session_id, variant_id, normalized_base_quantity, count_status)
  select s.id, v.id, null, 'not_counted'
    from public.product_variants v join public.products p on p.id = v.product_id
   where v.shop_id = s.shop_id and v.is_active and p.is_active
     and not exists (select 1 from public.stock_count_lines l where l.session_id = s.id and l.variant_id = v.id);

  update public.stock_count_sessions
     set status = 'confirmed', confirmed_by = auth.uid(), confirmed_at = now(), counted_at = now(), revision = revision + 1
   where id = s.id returning * into s;

  insert into public.audit_logs (shop_id, user_id, action, entity_type, entity_id, after_data)
  values (s.shop_id, auth.uid(), 'confirm_count', 'stock_count_sessions', s.id,
          jsonb_build_object('business_date', s.business_date, 'counted', v_counted, 'not_counted', v_missing));
  return jsonb_build_object('session_id', s.id, 'revision', s.revision, 'already_confirmed', false,
                            'business_date', s.business_date, 'counted', v_counted, 'not_counted', v_missing);
end $$;

-- ---------- discard_count_draft ----------
create function public.discard_count_draft(p_session uuid, p_revision integer)
returns void language plpgsql security definer set search_path = public as $$
declare s public.stock_count_sessions;
begin
  select * into s from public.stock_count_sessions where id = p_session for update;
  if not found then return; end if; -- already gone: idempotent
  if not public.has_shop_role(s.shop_id, array['owner','stock_manager']::public.member_role[]) then raise exception 'FORBIDDEN'; end if;
  if s.status <> 'draft' then raise exception 'ALREADY_CONFIRMED'; end if;
  if p_revision is distinct from s.revision then raise exception 'REVISION_CONFLICT'; end if;
  insert into public.audit_logs (shop_id, user_id, action, entity_type, entity_id, before_data)
  values (s.shop_id, auth.uid(), 'discard_draft', 'stock_count_sessions', s.id, to_jsonb(s));
  delete from public.stock_count_sessions where id = s.id;
end $$;

revoke execute on function public.save_count_draft(uuid, date, jsonb, integer), public.confirm_count(uuid, integer, boolean),
  public.discard_count_draft(uuid, integer) from public, anon;
grant execute on function public.save_count_draft(uuid, date, jsonb, integer), public.confirm_count(uuid, integer, boolean),
  public.discard_count_draft(uuid, integer) to authenticated;

-- Direct client writes to count tables are no longer needed: everything goes through the functions above.
drop policy sessions_insert on public.stock_count_sessions;
drop policy sessions_update_draft on public.stock_count_sessions;
drop policy lines_write_draft on public.stock_count_lines;
revoke insert, update, delete on public.stock_count_sessions, public.stock_count_lines from authenticated;
