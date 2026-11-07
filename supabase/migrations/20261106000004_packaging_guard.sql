-- Phase 3: packaging hierarchy integrity, enforced in the database.
-- Mirrors src/lib/calculations/packaging.ts (the TypeScript engine validates first for friendly
-- errors; this trigger is the authority and cannot be bypassed by API clients).
--
-- Semantics: parent_unit_id = the next-SMALLER unit this unit is made of (NULL = made of base units);
--            conversion_factor = how many of that unit one of this unit contains;
--            base_unit_multiplier = base units per 1 of this unit (derived; client values are ignored).

create function public.packaging_units_guard() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_base text;
  v_parent public.packaging_units;
  v_cursor uuid;
  v_depth int := 0;
  v_mult numeric;
begin
  if tg_op = 'UPDATE' and new.variant_id <> old.variant_id then raise exception 'VARIANT_IMMUTABLE'; end if;

  select base_inventory_unit into v_base from public.product_variants where id = new.variant_id;
  if lower(btrim(new.name)) = lower(btrim(v_base)) then raise exception 'NAME_EQUALS_BASE'; end if;

  if new.parent_unit_id is null then
    v_mult := new.conversion_factor;
  else
    if new.parent_unit_id = new.id then raise exception 'SELF_PARENT'; end if;
    select * into v_parent from public.packaging_units where id = new.parent_unit_id;
    -- A unit can only be built from units of the SAME variant: sizes are never mixed.
    if not found or v_parent.variant_id <> new.variant_id then raise exception 'PARENT_OTHER_VARIANT'; end if;
    if new.is_active and not v_parent.is_active then raise exception 'INACTIVE_PARENT'; end if;

    -- Walk up the chain: reaching ourselves means a cycle; chains are limited to 5 units.
    v_cursor := new.parent_unit_id;
    while v_cursor is not null loop
      v_depth := v_depth + 1;
      if v_cursor = new.id then raise exception 'CIRCULAR_PACKAGING'; end if;
      if v_depth > 4 then raise exception 'PACKAGING_TOO_DEEP'; end if;
      select parent_unit_id into v_cursor from public.packaging_units where id = v_cursor;
    end loop;
    v_mult := new.conversion_factor * v_parent.base_unit_multiplier;
  end if;

  if v_mult > 1000000 then raise exception 'MULTIPLIER_TOO_LARGE'; end if;
  new.base_unit_multiplier := v_mult;

  if tg_op = 'UPDATE' then
    -- Changing what a unit means would silently reinterpret past movements. Create a new unit instead.
    if (new.conversion_factor <> old.conversion_factor
        or new.parent_unit_id is distinct from old.parent_unit_id
        or new.base_unit_multiplier <> old.base_unit_multiplier)
       and exists (select 1 from public.stock_movements where input_unit_id = new.id) then
      raise exception 'PACKAGING_IN_USE';
    end if;
    -- Deactivating a unit would orphan active units built on it.
    if old.is_active and not new.is_active
       and exists (select 1 from public.packaging_units where parent_unit_id = new.id and is_active) then
      raise exception 'HAS_ACTIVE_CHILDREN';
    end if;
  end if;
  return new;
end $$;

create trigger packaging_units_guard_trg before insert or update on public.packaging_units
  for each row execute function public.packaging_units_guard();

-- When a unit's size changes, units built on it get their multipliers recomputed
-- (touching them re-runs the guard above, which also protects anything already used).
create function public.packaging_units_cascade() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.base_unit_multiplier <> old.base_unit_multiplier then
    update public.packaging_units set conversion_factor = conversion_factor where parent_unit_id = new.id;
  end if;
  return null;
end $$;
create trigger packaging_units_cascade_trg after update on public.packaging_units
  for each row execute function public.packaging_units_cascade();

-- Audit trail for packaging changes (the generic audit function needs a shop_id column, so resolve via the variant).
create function public.audit_packaging_change() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_row public.packaging_units := coalesce(new, old);
begin
  insert into public.audit_logs (shop_id, user_id, action, entity_type, entity_id, before_data, after_data)
  values (public.variant_shop_id(v_row.variant_id), auth.uid(), lower(tg_op), 'packaging_units', v_row.id,
          case when tg_op = 'UPDATE' then to_jsonb(old) end, case when tg_op <> 'DELETE' then to_jsonb(new) end);
  return null;
end $$;
create trigger audit_packaging after insert or update on public.packaging_units
  for each row execute function public.audit_packaging_change();

revoke execute on function public.packaging_units_guard(), public.packaging_units_cascade(), public.audit_packaging_change()
  from public, anon, authenticated;

-- Packaging definitions are never hard-deleted by clients (deactivate instead); keeps history interpretable.
revoke delete on public.packaging_units from authenticated;

-- Realistic ceiling matching the TypeScript engine.
alter table public.packaging_units add constraint packaging_multiplier_cap check (base_unit_multiplier <= 1000000);
