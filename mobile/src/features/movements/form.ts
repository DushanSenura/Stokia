import type { CatalogItem } from "@/features/inventory/catalog-types";
import type { MovementDraft, MovementWhen, PhoneMovementType } from "@/features/movements/phone-types";
import { normalizePackagingQuantity, type PackUnit } from "@/lib/calculations/packaging";
import { signedEffect } from "@/lib/calculations/reconcile";
import type { MessageKey } from "@/i18n";

/**
 * The phone's movement form, as pure logic. The checks here only spare the person a round trip: the server validates everything
 * again (with the web form's own schema), so a rule changed there is still enforced even if this file lags behind.
 */
export const QTY_RE = /^\d{1,9}(\.\d{1,3})?$/;
export const MONEY_RE = /^\d{1,10}(\.\d{1,2})?$/;

export interface UnitOption { id: string | null; label: string }

/** Every way to enter a quantity for this product: each packaging unit, then loose items in the base unit. */
export const unitOptions = (item: Pick<CatalogItem, "units" | "baseUnit">): UnitOption[] => [
  ...item.units.map((u) => ({ id: u.id as string | null, label: u.name })),
  { id: null, label: item.baseUnit },
];

const packUnits = (item: Pick<CatalogItem, "units">): PackUnit[] => item.units.map((u) => ({ id: u.id, name: u.name, parentId: u.parentId, factor: u.factor }));

/** The quantity in the base unit, worked out with the shared packaging engine (fractional bundles and wrong units are refused). */
export function baseQuantity(item: Pick<CatalogItem, "units" | "baseUnit">, unitId: string | null, quantity: string): string | null {
  const q = quantity.trim();
  if (!QTY_RE.test(q) || Number(q) <= 0) return null;
  const r = normalizePackagingQuantity([{ unitId, quantity: q }], packUnits(item), item.baseUnit);
  return r.ok && r.counted ? r.baseQuantity : null;
}

/** Does this type add stock, remove it, or leave the choice to the person? Derived from the shared rule, never repeated here. */
export function signOf(type: PhoneMovementType): "add" | "remove" | "choose" {
  try {
    return signedEffect(type, "1").startsWith("-") ? "remove" : "add";
  } catch {
    return "choose"; // "direction required": a manual adjustment
  }
}

/** The signed effect on stock in the base unit, or null while the form is not complete enough to know it. */
export function effectOf(type: PhoneMovementType, direction: "in" | "out" | undefined, base: string | null): string | null {
  if (base === null) return null;
  try { return signedEffect(type, base, direction); } catch { return null; }
}

export const takesSupplier = (t: PhoneMovementType) => t === "stock_received" || t === "supplier_return";
export const takesCost = (t: PhoneMovementType) => t === "stock_received";

/** Everything the person has filled in (the product is a catalog item, the rest is plain text). */
export interface FormState {
  item: CatalogItem | null;
  type: PhoneMovementType;
  direction: "in" | "out" | undefined;
  unitId: string | null;
  quantity: string;
  when: MovementWhen;
  reason: string;
  reference: string;
  supplier: string;
  cost: string;
}

export const blankForm = (): FormState => ({ item: null, type: "stock_received", direction: undefined, unitId: null, quantity: "", when: "now", reason: "", reference: "", supplier: "", cost: "" });

/** Field-by-field problems, as the web app's own message keys. An empty object means the form is ready to send. */
export function problemsIn(f: FormState): Record<string, MessageKey> {
  const p: Record<string, MessageKey> = {};
  if (!f.item) p.variant_id = "mv.form.pick";
  if (f.item ? baseQuantity(f.item, f.unitId, f.quantity) === null : !QTY_RE.test(f.quantity.trim()) || Number(f.quantity) <= 0) p.quantity = "mv.err.quantity";
  if (signOf(f.type) === "choose" && !f.direction) p.direction = "mv.err.direction";
  if (!f.reason.trim() && !f.reference.trim()) p.reason = "mv.err.reason";
  if (takesCost(f.type) && f.cost.trim() && !MONEY_RE.test(f.cost.trim())) p.cost = "cat.error.money";
  return p;
}

/** What is sent. Empty optional fields are left out; text is trimmed; fields that do not apply to this type are never sent. */
export function buildDraft(f: FormState): MovementDraft {
  if (!f.item) throw new Error("NO_PRODUCT");
  const d: MovementDraft = { variantId: f.item.variantId, type: f.type, unitId: f.unitId, quantity: f.quantity.trim(), when: f.when };
  if (signOf(f.type) === "choose") d.direction = f.direction;
  if (f.reason.trim()) d.reason = f.reason.trim();
  if (f.reference.trim()) d.reference = f.reference.trim();
  if (takesSupplier(f.type) && f.supplier.trim()) d.supplier = f.supplier.trim();
  if (takesCost(f.type) && f.cost.trim()) d.cost = f.cost.trim();
  return d;
}
