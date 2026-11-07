-- Phase 11: retry-safe, conflict-aware count submission for offline / multi-device use.
--
-- Problems this solves (all found by reading the Phase 4 functions):
--   1. "save, then confirm" was two calls. If the connection dropped between them, the retry collided with its
--      own revision bump and was reported as a conflict.
--   2. A device that was offline while ANOTHER device confirmed the same morning got ALREADY_CONFIRMED, which the
--      app treated as success, although its numbers were never applied.
--   3. A conflict carried no detail, so no screen could show the person what the other device recorded.
--
-- submit_count does save (+ optional confirm) in ONE transaction, keyed by a client-generated idempotency key:
--   * same key, same request   -> the original result is returned again (`replayed: true`), nothing is applied twice;
--   * same key, different data -> IDEMPOTENCY_KEY_REUSED (a bug in the client, never silently accepted);
--   * stale revision / already confirmed by another submission -> a structured `conflict` result that includes the
--     server's current copy, and an audit row. Nothing is overwritten.
-- A queued offline submission is therefore "confirmed" only when this function answers `confirmed`.

create table public.idempotency_records (
  shop_id uuid not null references public.shops (id) on delete cascade,
  key text not null check (char_length(key) between 8 and 100),
  user_id uuid not null,
  device_id text check (device_id is null or char_length(device_id) <= 100),
  operation text not null,
  request_hash text not null,
  response jsonb not null,
  created_at timestamptz not null default now(),
  primary key (shop_id, key)
);
create index idempotency_records_created_idx on public.idempotency_records (shop_id, created_at);
alter table public.idempotency_records enable row level security;
-- No policy and no grant: only the SECURITY DEFINER function below reads or writes this table.
revoke all on table public.idempotency_records from anon, authenticated;

-- The server's current copy of a day's count, for conflict screens.
create function public._count_snapshot(p_shop uuid, p_date date) returns jsonb
language plpgsql stable set search_path = public as $$
declare s public.stock_count_sessions; v_by text;
begin
  select * into s from public.stock_count_sessions where shop_id = p_shop and business_date = p_date;
  if not found then return null; end if;
  select display_name into v_by from public.user_profiles where id = coalesce(s.confirmed_by, s.created_by);
  return jsonb_build_object(
    'session_id', s.id, 'revision', s.revision, 'status', s.status, 'business_date', s.business_date,
    'confirmed_at', s.confirmed_at, 'by', v_by,
    'lines', coalesce((select jsonb_agg(jsonb_build_object('variant_id', l.variant_id, 'quantity', l.normalized_base_quantity::text) order by l.variant_id)
                         from public.stock_count_lines l where l.session_id = s.id and l.count_status = 'counted'), '[]'::jsonb));
end $$;
revoke execute on function public._count_snapshot(uuid, date) from public, anon, authenticated;

-- p_base_revision: the revision the device last saw (NULL = the device believes no session exists yet).
create function public.submit_count(
  p_shop uuid, p_date date, p_lines jsonb, p_base_revision integer, p_key text,
  p_confirm boolean default true, p_ack_missing boolean default false, p_device text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_hash text;
  rec public.idempotency_records;
  saved jsonb;
  conf jsonb;
  v_reason text;
  v_snapshot jsonb;
  v_result jsonb;
begin
  if not public.has_shop_role(p_shop, array['owner','stock_manager']::public.member_role[]) then raise exception 'FORBIDDEN'; end if;
  if p_key is null or char_length(p_key) not between 8 and 100 then raise exception 'INVALID_KEY'; end if;
  if jsonb_typeof(p_lines) is distinct from 'array' then raise exception 'INVALID_PAYLOAD'; end if;

  -- Two simultaneous requests with the same key are serialised; the second sees the first's stored answer.
  perform pg_advisory_xact_lock(hashtextextended(p_shop::text || ':' || p_key, 0));
  v_hash := md5(concat_ws('|', p_date::text, coalesce(p_base_revision::text, '-'), p_confirm::text, coalesce(p_ack_missing, false)::text, p_lines::text));

  select * into rec from public.idempotency_records where shop_id = p_shop and key = p_key;
  if found then
    if rec.request_hash <> v_hash then raise exception 'IDEMPOTENCY_KEY_REUSED'; end if;
    return rec.response || jsonb_build_object('replayed', true);
  end if;
  delete from public.idempotency_records where shop_id = p_shop and created_at < now() - interval '30 days';

  begin -- sub-transaction: if anything inside fails, the draft save is rolled back with it
    saved := public.save_count_draft(p_shop, p_date, p_lines, p_base_revision);
    if p_confirm then
      conf := public.confirm_count((saved->>'session_id')::uuid, (saved->>'revision')::integer, p_ack_missing);
    end if;
  exception when others then
    if sqlerrm not in ('REVISION_CONFLICT', 'ALREADY_CONFIRMED') then raise; end if;
    v_reason := case sqlerrm when 'ALREADY_CONFIRMED' then 'already_confirmed' else 'revision' end;
    v_snapshot := public._count_snapshot(p_shop, p_date);
    insert into public.audit_logs (shop_id, user_id, action, entity_type, entity_id, after_data)
    values (p_shop, auth.uid(), 'count_sync_conflict', 'stock_count_sessions', (v_snapshot->>'session_id')::uuid,
            jsonb_build_object('business_date', p_date, 'reason', v_reason, 'device', p_device, 'base_revision', p_base_revision));
    return jsonb_build_object('status', 'conflict', 'reason', v_reason, 'business_date', p_date, 'server', v_snapshot);
  end;

  v_result := jsonb_build_object(
    'status', case when p_confirm then 'confirmed' else 'saved' end,
    'session_id', saved->>'session_id',
    'revision', coalesce(conf->>'revision', saved->>'revision')::integer,
    'business_date', p_date,
    'counted', (saved->>'counted')::integer,
    'not_counted', (conf->>'not_counted')::integer,
    'replayed', false);
  insert into public.idempotency_records (shop_id, key, user_id, device_id, operation, request_hash, response)
  values (p_shop, p_key, auth.uid(), left(p_device, 100), 'submit_count', v_hash, v_result - 'replayed');
  return v_result;
end $$;

revoke execute on function public.submit_count(uuid, date, jsonb, integer, text, boolean, boolean, text) from public, anon;
grant execute on function public.submit_count(uuid, date, jsonb, integer, text, boolean, boolean, text) to authenticated;
