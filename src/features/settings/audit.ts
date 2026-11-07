/**
 * Pure helpers for showing audit records to people (no React, no database).
 * Audit rows hold raw before/after JSON; the viewer shows what CHANGED, not a wall of fields.
 */

/** Keys we never show raw values for (tokens, hashes) even though the audit table should not contain them. */
const SECRET_KEY = /pass(word)?|secret|token|hash|key$/i;
const NOISE_KEYS = new Set(["updated_at", "created_at", "revision", "calculated_at"]);

export interface FieldChange { field: string; before: string; after: string }

const show = (v: unknown): string => {
  if (v === null || v === undefined) return "—";
  if (typeof v === "string") return v.length > 120 ? `${v.slice(0, 117)}…` : v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  const s = JSON.stringify(v);
  return s.length > 120 ? `${s.slice(0, 117)}…` : s;
};

/** Fields whose value differs between before and after. For inserts (no before) every field is "new". */
export function changedFields(before: Record<string, unknown> | null, after: Record<string, unknown> | null): FieldChange[] {
  const b = before ?? {}, a = after ?? {};
  const keys = [...new Set([...Object.keys(b), ...Object.keys(a)])].filter((k) => !NOISE_KEYS.has(k));
  return keys
    .filter((k) => JSON.stringify(b[k]) !== JSON.stringify(a[k]))
    .map((k) => (SECRET_KEY.test(k) ? { field: k, before: "••••", after: "••••" } : { field: k, before: show(b[k]), after: show(a[k]) }))
    .sort((x, y) => x.field.localeCompare(y.field));
}

/** Pretty JSON for the details view, with secret-looking keys masked. */
export function maskedJson(obj: Record<string, unknown> | null): string {
  if (!obj) return "—";
  return JSON.stringify(obj, (k, v) => (k && SECRET_KEY.test(k) ? "••••" : v), 2);
}

/** Known action codes (translated in the UI); anything else is shown as the raw code. */
export const KNOWN_ACTIONS = [
  "insert", "update", "delete", "confirm_count", "discard_draft", "set_price", "import_catalog", "export_report",
  "request_correction", "apply_correction", "reject_correction", "repair_sales", "export_backup", "count_sync_conflict",
] as const;

export const KNOWN_ENTITIES = [
  "shops", "shop_memberships", "categories", "products", "product_variants", "packaging_units", "stock_count_sessions", "stock_count_lines",
  "stock_count_corrections", "stock_movements", "report_exports",
] as const;
