-- Stokia core schema (Phase 1 foundation)
-- Conventions:
--   * Quantities: numeric(18,3). Money: numeric(14,2) (LKR). Never floats.
--   * Timestamps stored as timestamptz (UTC). Business dates are plain `date`
--     in the shop's timezone (default Asia/Colombo).
--   * Referenced rows are never hard-deleted: use is_active / archived_at.

-- ---------- enums ----------
create type public.member_role as enum ('owner', 'stock_manager', 'viewer');
create type public.membership_status as enum ('invited', 'active', 'suspended');
create type public.count_session_status as enum ('draft', 'needs_review', 'confirmed', 'corrected');
create type public.count_line_status as enum ('counted', 'not_counted');
create type public.movement_type as enum (
  'stock_received', 'supplier_return', 'customer_return', 'damaged', 'expired',
  'discarded', 'manual_adjustment', 'repacking'
);
create type public.sales_calc_status as enum ('pending', 'calculated', 'needs_review', 'recalculated');
create type public.price_type as enum ('selling', 'purchase_cost');

-- ---------- shared trigger functions ----------
create function public.set_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

-- ---------- tenancy ----------
create table public.shops (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(btrim(name)) between 2 and 80),
  currency text not null default 'LKR' check (currency = 'LKR'),
  timezone text not null default 'Asia/Colombo',
  settings jsonb not null default '{}'::jsonb,
  created_by uuid references auth.users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger shops_updated before update on public.shops
  for each row execute function public.set_updated_at();

create table public.user_profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text not null default '',
  preferred_language text not null default 'en' check (preferred_language in ('en', 'si')),
  created_at timestamptz not null default now()
);

create table public.shop_memberships (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role public.member_role not null,
  status public.membership_status not null default 'active',
  created_at timestamptz not null default now(),
  unique (shop_id, user_id)
);
create index shop_memberships_user_idx on public.shop_memberships (user_id) where status = 'active';

-- ---------- catalog ----------
create table public.categories (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops (id) on delete cascade,
  name text not null check (char_length(btrim(name)) > 0),
  description text,
  parent_id uuid references public.categories (id) on delete set null,
  created_at timestamptz not null default now()
);
create unique index categories_shop_name_uq on public.categories (shop_id, lower(name));

create table public.products (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops (id) on delete cascade,
  category_id uuid references public.categories (id) on delete set null,
  name text not null check (char_length(btrim(name)) > 0),
  product_code text not null,
  description text,
  image_url text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index products_shop_code_uq on public.products (shop_id, lower(product_code));
create index products_shop_active_idx on public.products (shop_id, is_active);
create trigger products_updated before update on public.products
  for each row execute function public.set_updated_at();

create table public.product_variants (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products (id) on delete restrict,
  shop_id uuid not null references public.shops (id) on delete cascade, -- denormalised for RLS/perf
  sku text not null,
  size_value numeric(12,3) check (size_value is null or size_value > 0),
  size_unit text check (size_unit in ('g', 'kg', 'ml', 'l', 'pcs')),
  base_inventory_unit text not null default 'packet',
  barcode text,
  low_stock_threshold numeric(18,3) not null default 0 check (low_stock_threshold >= 0),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index variants_shop_sku_uq on public.product_variants (shop_id, lower(sku));
create unique index variants_shop_barcode_uq on public.product_variants (shop_id, barcode) where barcode is not null;
create index variants_product_idx on public.product_variants (product_id);
create trigger variants_updated before update on public.product_variants
  for each row execute function public.set_updated_at();

create table public.packaging_units (
  id uuid primary key default gen_random_uuid(),
  variant_id uuid not null references public.product_variants (id) on delete restrict,
  name text not null check (char_length(btrim(name)) > 0),
  parent_unit_id uuid references public.packaging_units (id) on delete restrict,
  conversion_factor numeric(18,6) not null check (conversion_factor > 0),   -- parent units contained
  base_unit_multiplier numeric(18,6) not null check (base_unit_multiplier > 0), -- base units per 1 of this unit
  is_active boolean not null default true,
  check (parent_unit_id is null or parent_unit_id <> id)
);
create unique index packaging_variant_name_uq on public.packaging_units (variant_id, lower(name)) where is_active;

create table public.product_price_history (
  id uuid primary key default gen_random_uuid(),
  variant_id uuid not null references public.product_variants (id) on delete restrict,
  price_type public.price_type not null,
  amount_lkr numeric(14,2) not null check (amount_lkr >= 0),
  effective_from timestamptz not null,
  effective_to timestamptz,
  created_at timestamptz not null default now(),
  check (effective_to is null or effective_to > effective_from)
);
-- Prevent overlapping price periods per variant/type (historical prices stay exact).
-- Installed in the `extensions` schema (Supabase's convention) so its internal helper functions are not exposed in `public`.
create schema if not exists extensions;
create extension if not exists btree_gist schema extensions;
alter table public.product_price_history
  add constraint price_history_no_overlap exclude using gist (
    variant_id with =, price_type with =,
    tstzrange(effective_from, coalesce(effective_to, 'infinity')) with &&
  );

-- ---------- stock counts ----------
create table public.stock_count_sessions (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops (id) on delete cascade,
  business_date date not null,            -- the morning this count was taken (NOT the sales date)
  counted_at timestamptz not null default now(),
  status public.count_session_status not null default 'draft',
  revision integer not null default 1,    -- optimistic concurrency
  created_by uuid not null references auth.users (id),
  confirmed_by uuid references auth.users (id),
  confirmed_at timestamptz,
  unique (shop_id, business_date)
);

create table public.stock_count_lines (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.stock_count_sessions (id) on delete cascade,
  variant_id uuid not null references public.product_variants (id) on delete restrict,
  normalized_base_quantity numeric(18,3),   -- NULL = not counted (never zero by default)
  entry_details jsonb not null default '{}'::jsonb,
  count_status public.count_line_status not null default 'not_counted',
  unique (session_id, variant_id),
  -- a counted line must have a quantity >= 0; an uncounted line must not
  check ((count_status = 'counted' and normalized_base_quantity >= 0)
      or (count_status = 'not_counted' and normalized_base_quantity is null))
);

create table public.stock_movements (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops (id) on delete cascade,
  variant_id uuid not null references public.product_variants (id) on delete restrict,
  type public.movement_type not null,
  input_quantity numeric(18,3) not null,
  input_unit_id uuid references public.packaging_units (id) on delete restrict,
  normalized_base_quantity numeric(18,3) not null, -- signed effect on stock for adjustments; positive otherwise
  effective_at timestamptz not null,
  reason text,
  reference text,
  supplier text,
  purchase_cost_lkr numeric(14,2) check (purchase_cost_lkr is null or purchase_cost_lkr >= 0),
  idempotency_key text not null,
  created_by uuid not null references auth.users (id),
  created_at timestamptz not null default now(),
  unique (shop_id, idempotency_key)
);
create index stock_movements_variant_time_idx on public.stock_movements (variant_id, effective_at);

create table public.daily_sales (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops (id) on delete cascade,
  variant_id uuid not null references public.product_variants (id) on delete restrict,
  sales_date date not null,   -- the day the stock was sold (day BEFORE the closing count)
  opening_count_id uuid references public.stock_count_lines (id),
  closing_count_id uuid references public.stock_count_lines (id),
  inferred_base_units_sold numeric(18,3),
  estimated_sales_amount numeric(14,2),
  price_reference numeric(14,2),
  calculation_status public.sales_calc_status not null default 'pending',
  calculation_revision integer not null default 1,
  calculated_at timestamptz not null default now(),
  unique (shop_id, variant_id, sales_date)
);
create index daily_sales_shop_date_idx on public.daily_sales (shop_id, sales_date);

create table public.stock_count_corrections (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.stock_count_sessions (id),
  variant_id uuid not null references public.product_variants (id),
  old_quantity numeric(18,3),
  new_quantity numeric(18,3) not null check (new_quantity >= 0),
  reason text not null check (char_length(btrim(reason)) > 0),
  created_by uuid not null references auth.users (id),
  created_at timestamptz not null default now()
);

create table public.audit_logs (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid references public.shops (id) on delete cascade,
  user_id uuid,
  action text not null,
  entity_type text not null,
  entity_id uuid,
  before_data jsonb,
  after_data jsonb,
  created_at timestamptz not null default now()
);
create index audit_logs_shop_time_idx on public.audit_logs (shop_id, created_at desc);

-- ---------- audit trigger ----------
create function public.audit_row_change() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_row jsonb := to_jsonb(coalesce(new, old));
  v_shop uuid;
begin
  v_shop := case tg_table_name when 'shops' then (v_row->>'id')::uuid else (v_row->>'shop_id')::uuid end;
  insert into public.audit_logs (shop_id, user_id, action, entity_type, entity_id, before_data, after_data)
  values (v_shop, auth.uid(), lower(tg_op), tg_table_name, (v_row->>'id')::uuid,
          case when tg_op in ('UPDATE','DELETE') then to_jsonb(old) end,
          case when tg_op in ('INSERT','UPDATE') then to_jsonb(new) end);
  return coalesce(new, old);
end $$;

create trigger audit_shops after insert or update on public.shops
  for each row execute function public.audit_row_change();
create trigger audit_memberships after insert or update or delete on public.shop_memberships
  for each row execute function public.audit_row_change();
create trigger audit_categories after insert or update or delete on public.categories
  for each row execute function public.audit_row_change();
create trigger audit_products after insert or update on public.products
  for each row execute function public.audit_row_change();
create trigger audit_variants after insert or update on public.product_variants
  for each row execute function public.audit_row_change();
create trigger audit_movements after insert on public.stock_movements
  for each row execute function public.audit_row_change();
create trigger audit_sessions after insert or update on public.stock_count_sessions
  for each row execute function public.audit_row_change();

-- ---------- new-user profile ----------
create function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.user_profiles (id, display_name)
  values (new.id, coalesce(nullif(new.raw_user_meta_data->>'display_name', ''), split_part(new.email, '@', 1)))
  on conflict (id) do nothing;
  return new;
end $$;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();
