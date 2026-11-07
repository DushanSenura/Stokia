-- Phase 13: a second stock sheet on the same day, only with the owner's approval, and only for the person who asked.
--
-- THE RULE
--   * One stock sheet per shop per day is the normal case (unique (shop, business_date) already enforces it).
--   * A stock manager who needs to count AGAIN on the same day asks for it (request_recount) with a reason.
--     The owner approves or rejects (decide_recount). Only the person who asked can then use it (submit_recount); nobody else can,
--     not even another stock manager. An owner's own request is approved in the same step (still fully recorded).
--   * The approved recount REPLACES the day's figures. Nothing is deleted: every changed line is kept as an approved row in
--     stock_count_corrections (old and new quantity, who, why) and the day's sales are recalculated with history, exactly like a
--     correction. It is treated as a correction of that morning's count: the count's time is NOT moved, so stock that really moved
--     after the morning count belongs in a recorded movement, not in a recount.
--   * A request only works on the shop's CURRENT date (older days go through ordinary corrections) and expires with the day.

create table public.recount_requests (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops (id) on delete cascade,
  session_id uuid not null references public.stock_count_sessions (id) on delete restrict,
  business_date date not null,
  requested_by uuid not null references auth.users (id),
  reason text not null check (char_length(btrim(reason)) > 0),
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'cancelled', 'used')),
  decided_by uuid references auth.users (id),
  decided_at timestamptz,
  decision_note text,
  used_at timestamptz,
  submit_key text,
  changed_lines integer,
  created_at timestamptz not null default now()
);
-- one open (pending or approved, not yet used) request per day and person
create unique index recount_one_open on public.recount_requests (session_id, requested_by) where status in ('pending', 'approved');
create index recount_shop_idx on public.recount_requests (shop_id, created_at desc);

alter table public.recount_requests enable row level security;
-- The owner sees every request in the shop; a stock manager sees their own. Written only by the functions below.
create policy recount_select on public.recount_requests for select to authenticated
  using (public.has_shop_role(shop_id, array['owner']::public.member_role[])
         or (requested_by = auth.uid() and public.has_shop_role(shop_id, array['stock_manager']::public.member_role[])));
revoke insert, update, delete on public.recount_requests from authenticated;
revoke all on public.recount_requests from anon;

-- ---------- ask for another stock sheet today ----------
create function public.request_recount(p_session uuid, p_reason text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  s public.stock_count_sessions;
  v_tz text;
  v_id uuid;
begin
  select * into s from public.stock_count_sessions where id = p_session for update;
  if not found then raise exception 'NOT_FOUND'; end if;
  if not public.has_shop_role(s.shop_id, array['owner', 'stock_manager']::public.member_role[]) then raise exception 'FORBIDDEN'; end if;
  if s.status not in ('confirmed', 'corrected') then raise exception 'NOT_CONFIRMED'; end if;   -- an unconfirmed sheet is simply edited
  if char_length(btrim(coalesce(p_reason, ''))) = 0 then raise exception 'REASON_REQUIRED'; end if;
  select timezone into v_tz from public.shops where id = s.shop_id;
  if s.business_date <> (now() at time zone v_tz)::date then raise exception 'NOT_TODAY'; end if;
  if exists (select 1 from public.recount_requests where session_id = s.id and requested_by = auth.uid() and status in ('pending', 'approved')) then
    raise exception 'ALREADY_OPEN';
  end if;

  insert into public.recount_requests (shop_id, session_id, business_date, requested_by, reason)
  values (s.shop_id, s.id, s.business_date, auth.uid(), btrim(p_reason)) returning id into v_id;
  insert into public.audit_logs (shop_id, user_id, action, entity_type, entity_id, after_data)
  values (s.shop_id, auth.uid(), 'request_recount', 'recount_requests', v_id,
          jsonb_build_object('business_date', s.business_date, 'reason', btrim(p_reason)));

  -- Owners are the approvers: their own request is approved in the same step.
  if public.has_shop_role(s.shop_id, array['owner']::public.member_role[]) then
    update public.recount_requests set status = 'approved', decided_by = auth.uid(), decided_at = now(), decision_note = 'Requested and approved by the owner' where id = v_id;
    insert into public.audit_logs (shop_id, user_id, action, entity_type, entity_id, after_data)
    values (s.shop_id, auth.uid(), 'approve_recount', 'recount_requests', v_id, jsonb_build_object('self_approved', true));
    return jsonb_build_object('id', v_id, 'status', 'approved');
  end if;
  return jsonb_build_object('id', v_id, 'status', 'pending');
end $$;

-- ---------- the owner decides ----------
create function public.decide_recount(p_id uuid, p_approve boolean, p_note text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  r public.recount_requests;
  v_tz text;
begin
  select * into r from public.recount_requests where id = p_id for update;
  if not found then raise exception 'NOT_FOUND'; end if;
  if not public.has_shop_role(r.shop_id, array['owner']::public.member_role[]) then raise exception 'FORBIDDEN'; end if;
  if r.status <> 'pending' then raise exception 'NOT_PENDING'; end if;
  if p_approve then
    select timezone into v_tz from public.shops where id = r.shop_id;
    if r.business_date <> (now() at time zone v_tz)::date then raise exception 'EXPIRED'; end if;   -- it only works on its own day
    update public.recount_requests set status = 'approved', decided_by = auth.uid(), decided_at = now(), decision_note = nullif(btrim(coalesce(p_note, '')), '') where id = r.id;
    insert into public.audit_logs (shop_id, user_id, action, entity_type, entity_id, after_data)
    values (r.shop_id, auth.uid(), 'approve_recount', 'recount_requests', r.id, jsonb_build_object('requested_by', r.requested_by, 'business_date', r.business_date));
    return jsonb_build_object('id', r.id, 'status', 'approved');
  end if;
  if char_length(btrim(coalesce(p_note, ''))) = 0 then raise exception 'NOTE_REQUIRED'; end if;
  update public.recount_requests set status = 'rejected', decided_by = auth.uid(), decided_at = now(), decision_note = btrim(p_note) where id = r.id;
  insert into public.audit_logs (shop_id, user_id, action, entity_type, entity_id, after_data)
  values (r.shop_id, auth.uid(), 'reject_recount', 'recount_requests', r.id, jsonb_build_object('note', btrim(p_note), 'requested_by', r.requested_by));
  return jsonb_build_object('id', r.id, 'status', 'rejected');
end $$;

-- ---------- withdraw (the person who asked, or the owner) ----------
create function public.cancel_recount(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare r public.recount_requests;
begin
  select * into r from public.recount_requests where id = p_id for update;
  if not found then raise exception 'NOT_FOUND'; end if;
  if not (r.requested_by = auth.uid() and public.has_shop_role(r.shop_id, array['owner', 'stock_manager']::public.member_role[]))
     and not public.has_shop_role(r.shop_id, array['owner']::public.member_role[]) then raise exception 'FORBIDDEN'; end if;
  if r.status not in ('pending', 'approved') then raise exception 'NOT_OPEN'; end if;
  update public.recount_requests set status = 'cancelled', decided_by = coalesce(decided_by, auth.uid()), decided_at = coalesce(decided_at, now()) where id = r.id;
  insert into public.audit_logs (shop_id, user_id, action, entity_type, entity_id, after_data)
  values (r.shop_id, auth.uid(), 'cancel_recount', 'recount_requests', r.id, jsonb_build_object('was', r.status));
end $$;

-- ---------- the recount itself: only the person who asked, once, on that day ----------
-- p_lines = [{"variant_id": "...", "normalized_base_quantity": 12.5, "entry_details": {...}}, ...]. The server has already worked the
-- quantities out from the stored packaging; this function re-checks the rules that matter and applies them in one transaction.
create function public.submit_recount(p_request uuid, p_lines jsonb, p_key text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  r public.recount_requests;
  s public.stock_count_sessions;
  l public.stock_count_lines;
  e jsonb;
  v_tz text;
  v_variant uuid;
  v_qty numeric;
  v_details jsonb;
  v_changed integer := 0;
  v_seen uuid[] := '{}';
begin
  if p_key is null or char_length(btrim(p_key)) < 8 then raise exception 'KEY_REQUIRED'; end if;
  select * into r from public.recount_requests where id = p_request for update;
  if not found then raise exception 'NOT_FOUND'; end if;
  -- Only the person the owner approved. Another stock manager, and even the owner acting for them, cannot use it.
  if r.requested_by is distinct from auth.uid() then raise exception 'FORBIDDEN'; end if;
  if not public.has_shop_role(r.shop_id, array['owner', 'stock_manager']::public.member_role[]) then raise exception 'FORBIDDEN'; end if;

  if r.status = 'used' then
    if r.submit_key = btrim(p_key) then return jsonb_build_object('duplicate', true, 'changed', r.changed_lines); end if;
    raise exception 'ALREADY_USED';
  end if;
  if r.status <> 'approved' then raise exception 'NOT_APPROVED'; end if;

  select * into s from public.stock_count_sessions where id = r.session_id for update;
  select timezone into v_tz from public.shops where id = r.shop_id;
  if s.business_date <> (now() at time zone v_tz)::date then raise exception 'EXPIRED'; end if;
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then raise exception 'NO_LINES'; end if;

  for e in select value from jsonb_array_elements(p_lines) loop
    begin
      v_variant := (e->>'variant_id')::uuid;
      v_qty := (e->>'normalized_base_quantity')::numeric;
    exception when others then raise exception 'INVALID_LINE';
    end;
    if v_variant is null or v_qty is null or v_qty < 0 then raise exception 'INVALID_LINE'; end if;
    if v_variant = any (v_seen) then raise exception 'DUPLICATE_LINE'; end if;
    v_seen := v_seen || v_variant;
    if not exists (select 1 from public.product_variants where id = v_variant and shop_id = r.shop_id) then raise exception 'INVALID_VARIANT'; end if;
    v_details := coalesce(e->'entry_details', '{}'::jsonb);

    select * into l from public.stock_count_lines where session_id = s.id and variant_id = v_variant for update;
    if found and l.normalized_base_quantity is not distinct from v_qty then continue; end if;   -- unchanged: nothing to record

    -- the old figure stays in the correction history (old_quantity may be null: it was not counted before)
    insert into public.stock_count_corrections (session_id, variant_id, old_quantity, new_quantity, new_entry_details, reason, created_by, status, decided_by, decided_at, decision_note)
    values (s.id, v_variant, case when found then l.normalized_base_quantity end, v_qty, v_details,
            'Same-day recount: ' || r.reason, r.requested_by, 'approved', r.decided_by, coalesce(r.decided_at, now()), coalesce(r.decision_note, 'Approved recount'));

    if found then
      update public.stock_count_lines
         set normalized_base_quantity = v_qty, count_status = 'counted',
             entry_details = v_details || jsonb_build_object('corrected', true, 'recount_id', r.id,
                                            'previous', jsonb_build_object('quantity', l.normalized_base_quantity, 'details', l.entry_details))
       where id = l.id;
    else
      insert into public.stock_count_lines (session_id, variant_id, normalized_base_quantity, entry_details, count_status)
      values (s.id, v_variant, v_qty, v_details || jsonb_build_object('recount_id', r.id), 'counted');
    end if;
    v_changed := v_changed + 1;
  end loop;

  if v_changed = 0 then raise exception 'NO_CHANGE'; end if;

  update public.stock_count_sessions set status = 'corrected', revision = revision + 1 where id = s.id;
  update public.recount_requests set status = 'used', used_at = now(), submit_key = btrim(p_key), changed_lines = v_changed where id = r.id;

  -- The count is the closing count of the previous day and the opening count of its own day: recalculate both, with history.
  perform public._recalc_range(s.shop_id, s.business_date - 1, s.business_date, 'count_recounted');

  insert into public.audit_logs (shop_id, user_id, action, entity_type, entity_id, after_data)
  values (s.shop_id, auth.uid(), 'submit_recount', 'recount_requests', r.id,
          jsonb_build_object('business_date', s.business_date, 'changed_lines', v_changed, 'reason', r.reason, 'approved_by', r.decided_by));
  return jsonb_build_object('duplicate', false, 'changed', v_changed);
end $$;

revoke execute on function public.request_recount(uuid, text), public.decide_recount(uuid, boolean, text), public.cancel_recount(uuid),
  public.submit_recount(uuid, jsonb, text) from public, anon;
grant execute on function public.request_recount(uuid, text), public.decide_recount(uuid, boolean, text), public.cancel_recount(uuid),
  public.submit_recount(uuid, jsonb, text) to authenticated;
