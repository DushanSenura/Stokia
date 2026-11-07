import "server-only";
import type { PhoneMovement } from "@/features/movements/phone-types";
import { sizeLabel } from "@/lib/formatting/units";
import type { createClient } from "@/lib/supabase/server";
import { listMovements, type MovementListRow } from "@/server/repositories/movements";

type Supa = Awaited<ReturnType<typeof createClient>>;

/** The movement as the phone shows it. Pure, so the rules about what may be reversed are tested without a database. */
export function toPhoneMovement(r: MovementListRow, reversed: Set<string>, people: Map<string, string>): PhoneMovement {
  const v = r.product_variants;
  const isReversal = r.reversed_movement_id !== null;
  const isReversed = reversed.has(r.id);
  return {
    id: r.id,
    type: r.type,
    label: v ? `${v.products?.name ?? ""} ${sizeLabel(v.size_value, v.size_unit)}`.trim() : "",
    sku: v?.sku ?? "",
    baseUnit: v?.base_inventory_unit ?? "",
    effect: String(Number(r.normalized_base_quantity)),
    entered: `${Number(r.input_quantity)} ${r.packaging_units?.name ?? v?.base_inventory_unit ?? ""}`.trim(),
    effectiveAt: r.effective_at,
    createdAt: r.created_at,
    reason: r.reason, reference: r.reference, supplier: r.supplier,
    by: people.get(r.created_by) ?? null,
    reversed: isReversed,
    isReversal,
    // One half of a repacking must not be reversed on its own (it would create or destroy stock): that stays a careful web task.
    canReverse: !isReversal && !isReversed && r.type !== "repacking",
  };
}

/** The most recent movements, newest first. */
export async function loadRecentMovements(supabase: Supa, limit = 25): Promise<PhoneMovement[]> {
  const { rows, reversed, people, error } = await listMovements(supabase, { page: 1 });
  if (error) throw new Error("MOVEMENTS_QUERY_FAILED");
  return rows.slice(0, limit).map((r) => toPhoneMovement(r, reversed, people));
}
