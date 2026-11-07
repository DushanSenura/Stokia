-- Phase 2: catalog functions + product image storage.

-- ---------- internal price helper (not callable by API clients) ----------
-- Closes the open price period and opens a new one, so history stays contiguous and exact.
create function public._apply_price(p_variant uuid, p_type public.price_type, p_amount numeric, p_from timestamptz)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_last timestamptz;
  v_id uuid;
begin
  if p_amount is null or p_amount < 0 then raise exception 'INVALID_AMOUNT'; end if;
  select max(effective_from) into v_last
    from public.product_price_history where variant_id = p_variant and price_type = p_type;
  -- A new price can only start after the latest existing period began (no rewriting history).
  if v_last is not null and p_from <= v_last then raise exception 'PRICE_PERIOD_CONFLICT'; end if;

  update public.product_price_history set effective_to = p_from
   where variant_id = p_variant and price_type = p_type and effective_to is null;
  insert into public.product_price_history (variant_id, price_type, amount_lkr, effective_from)
  values (p_variant, p_type, round(p_amount, 2), p_from) returning id into v_id;
  return v_id;
end $$;
revoke execute on function public._apply_price(uuid, public.price_type, numeric, timestamptz) from public, anon, authenticated;

-- ---------- owner-facing price change ----------
create function public.set_variant_price(
  p_variant uuid, p_type public.price_type, p_amount numeric, p_effective_from timestamptz default now()
) returns uuid language plpgsql security definer set search_path = public as $$
declare v_shop uuid := public.variant_shop_id(p_variant);
begin
  if v_shop is null or not public.has_shop_role(v_shop, array['owner']::public.member_role[]) then
    raise exception 'FORBIDDEN';
  end if;
  insert into public.audit_logs (shop_id, user_id, action, entity_type, entity_id, after_data)
  values (v_shop, auth.uid(), 'set_price', 'product_variants', p_variant,
          jsonb_build_object('price_type', p_type, 'amount_lkr', p_amount, 'effective_from', p_effective_from));
  return public._apply_price(p_variant, p_type, p_amount, p_effective_from);
end $$;
revoke execute on function public.set_variant_price(uuid, public.price_type, numeric, timestamptz) from public, anon;
grant execute on function public.set_variant_price(uuid, public.price_type, numeric, timestamptz) to authenticated;

-- ---------- all-or-nothing catalog import ----------
-- p_products: [{product_code,name,category,description,variants:[{sku,size_value,size_unit,
--   base_inventory_unit,low_stock_threshold,barcode,selling_price,purchase_cost}]}]
-- Any conflict (duplicate code/SKU/barcode) raises and rolls back the entire import.
create function public.import_catalog(p_shop uuid, p_products jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  p jsonb; v jsonb;
  v_cat uuid; v_prod uuid; v_var uuid;
  n_products int := 0; n_variants int := 0;
begin
  if not public.has_shop_role(p_shop, array['owner']::public.member_role[]) then raise exception 'FORBIDDEN'; end if;
  if jsonb_typeof(p_products) <> 'array' or jsonb_array_length(p_products) > 2000 then raise exception 'INVALID_PAYLOAD'; end if;

  for p in select * from jsonb_array_elements(p_products) loop
    v_cat := null;
    if nullif(btrim(p->>'category'), '') is not null then
      select id into v_cat from public.categories where shop_id = p_shop and lower(name) = lower(btrim(p->>'category'));
      if v_cat is null then
        insert into public.categories (shop_id, name) values (p_shop, btrim(p->>'category')) returning id into v_cat;
      end if;
    end if;

    insert into public.products (shop_id, category_id, name, product_code, description)
    values (p_shop, v_cat, p->>'name', p->>'product_code', nullif(p->>'description', ''))
    returning id into v_prod;
    n_products := n_products + 1;

    for v in select * from jsonb_array_elements(p->'variants') loop
      insert into public.product_variants (product_id, shop_id, sku, size_value, size_unit, base_inventory_unit, low_stock_threshold, barcode)
      values (v_prod, p_shop, v->>'sku', nullif(v->>'size_value', '')::numeric, nullif(v->>'size_unit', ''),
              coalesce(nullif(v->>'base_inventory_unit', ''), 'packet'),
              coalesce(nullif(v->>'low_stock_threshold', '')::numeric, 0), nullif(v->>'barcode', ''))
      returning id into v_var;
      n_variants := n_variants + 1;
      if nullif(v->>'selling_price', '') is not null then
        perform public._apply_price(v_var, 'selling', (v->>'selling_price')::numeric, now());
      end if;
      if nullif(v->>'purchase_cost', '') is not null then
        perform public._apply_price(v_var, 'purchase_cost', (v->>'purchase_cost')::numeric, now());
      end if;
    end loop;
  end loop;

  insert into public.audit_logs (shop_id, user_id, action, entity_type, after_data)
  values (p_shop, auth.uid(), 'import_catalog', 'products', jsonb_build_object('products', n_products, 'variants', n_variants));
  return jsonb_build_object('products', n_products, 'variants', n_variants);
end $$;
revoke execute on function public.import_catalog(uuid, jsonb) from public, anon;
grant execute on function public.import_catalog(uuid, jsonb) to authenticated;

-- ---------- product images (public-read bucket, owner-write, path = <shop_id>/<file>) ----------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('product-images', 'product-images', true, 2097152, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update set file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

create policy product_images_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'product-images'
    and public.has_shop_role(((storage.foldername(name))[1])::uuid, array['owner']::public.member_role[]));
create policy product_images_update on storage.objects for update to authenticated
  using (bucket_id = 'product-images'
    and public.has_shop_role(((storage.foldername(name))[1])::uuid, array['owner']::public.member_role[]));
create policy product_images_delete on storage.objects for delete to authenticated
  using (bucket_id = 'product-images'
    and public.has_shop_role(((storage.foldername(name))[1])::uuid, array['owner']::public.member_role[]));

-- ---------- hardening: new functions must not be callable anonymously ----------
revoke execute on all functions in schema public from anon;
alter default privileges in schema public revoke execute on functions from anon;
