-- Stokia security verification. Run in the Supabase SQL editor (or psql) after applying the migrations.
-- EXPECTED RESULT: ZERO ROWS. Every row returned is a security problem, named in the `problem` column.
--
-- The same file is executed against the real migrations in tests/integration/rls-matrix.test.ts.

with
-- 1. Every table in `public` must have Row Level Security enabled.
rls_off as (
  select 'RLS_DISABLED' as problem, c.relname::text as detail
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity
),
-- 2. The anonymous role must hold no privilege on any public table.
anon_tables as (
  select 'ANON_TABLE_PRIVILEGE', table_name || ':' || privilege_type
    from information_schema.role_table_grants
   where grantee = 'anon' and table_schema = 'public'
),
-- 3. No policy may apply to PUBLIC/anon, and none may be unconditional (`using (true)`).
policy_for_anon as (
  select 'POLICY_FOR_ANON_OR_PUBLIC', tablename || '.' || policyname
    from pg_policies where schemaname = 'public' and (roles @> array['public']::name[] or roles @> array['anon']::name[])
),
policy_always_true as (
  select 'POLICY_ALWAYS_TRUE', tablename || '.' || policyname
    from pg_policies where schemaname = 'public' and (trim(coalesce(qual, '')) = 'true' or trim(coalesce(with_check, '')) = 'true')
),
-- 4. No function in `public` may be callable anonymously.
anon_functions as (
  select 'ANON_CAN_EXECUTE', p.proname::text
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.prokind = 'f' and has_function_privilege('anon', p.oid, 'execute')
),
-- 5. Internal helpers (leading underscore) and trigger functions must not be callable by signed-in users either.
internal_functions as (
  select 'INTERNAL_FUNCTION_CALLABLE', p.proname::text
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.prokind = 'f' and has_function_privilege('authenticated', p.oid, 'execute')
     and (p.proname like '\_%' escape '\' or p.prorettype = 'trigger'::regtype)
),
-- 6. SECURITY DEFINER functions must pin their search_path (prevents search-path hijacking).
definer_no_path as (
  select 'DEFINER_WITHOUT_SEARCH_PATH', p.proname::text
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.prosecdef
     and not exists (select 1 from unnest(coalesce(p.proconfig, '{}'::text[])) cfg where cfg like 'search_path=%')
),
-- 7. Only the intended SECURITY DEFINER entry points may be callable by signed-in users.
definer_allowlist as (
  select 'UNEXPECTED_DEFINER_ENTRY_POINT', p.proname::text
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.prosecdef and has_function_privilege('authenticated', p.oid, 'execute')
     and p.proname not in (
       'create_shop', 'save_count_draft', 'confirm_count', 'discard_count_draft', 'record_movement', 'record_repacking', 'reverse_movement',
       'set_variant_price', 'import_catalog', 'record_report_export', 'accept_invitation',
       'request_count_correction', 'decide_count_correction', 'cancel_count_correction',
       'data_health_check', 'repair_sales', 'record_backup_export', 'submit_count',
       'record_sales_breakdown', 'clear_sales_breakdown', 'set_packaging_price',
       'is_shop_member', 'has_shop_role', 'product_shop_id', 'variant_shop_id', 'session_shop_id')
),
-- 8. Append-only / derived tables must not be writable by API clients.
append_only as (
  select 'CLIENT_CAN_WRITE_PROTECTED_TABLE', t.tbl || ':' || t.priv
    from (values ('audit_logs'), ('daily_sales'), ('daily_sales_revisions'), ('stock_count_corrections'), ('stock_movements'),
                 ('report_exports'), ('stock_count_sessions'), ('stock_count_lines'),
                 ('sales_breakdowns'), ('sales_breakdown_lines'), ('sales_breakdown_revisions'), ('packaging_unit_price_history')) as tb(tbl)
    cross join (values ('INSERT'), ('UPDATE'), ('DELETE')) as pr(priv)
    cross join lateral (select tb.tbl, pr.priv) t
   where has_table_privilege('authenticated', 'public.' || tb.tbl, pr.priv)
),
-- 9. Tables that hold shop data must be scoped by shop (a shop_id column or a parent that is).
unscoped as (
  select 'TABLE_WITHOUT_SHOP_SCOPE', c.relname::text
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind = 'r'
     -- (packaging_unit_price_history and sales_breakdown_lines are scoped through their parent row, like product_price_history and stock_count_lines)
     and c.relname not in ('shops', 'user_profiles', 'packaging_units', 'product_price_history', 'stock_count_lines', 'stock_count_corrections',
                           'packaging_unit_price_history', 'sales_breakdown_lines')
     and not exists (select 1 from information_schema.columns col where col.table_schema = 'public' and col.table_name = c.relname and col.column_name = 'shop_id')
)
select * from rls_off
union all select * from anon_tables
union all select * from policy_for_anon
union all select * from policy_always_true
union all select * from anon_functions
union all select * from internal_functions
union all select * from definer_no_path
union all select * from definer_allowlist
union all select * from append_only
union all select * from unscoped;
