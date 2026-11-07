import "server-only";
import { z } from "zod";
import { buildEntryDetails } from "@/features/inventory/count-entry";
import type { CountConflict, CountInput, CountResult, SalesSummary } from "@/features/inventory/count-types";
import { normalizePackagingQuantity, type NormalizeError } from "@/lib/calculations/packaging";
import { isBusinessDate, salesDateFor } from "@/lib/dates/business";
import { sizeLabel } from "@/lib/formatting/units";
import type { createClient } from "@/lib/supabase/server";
import type { MessageKey } from "@/i18n";
import { getSalesForDate, summarizeSales } from "@/server/repositories/inventory";
import { toPackUnit, type PackagingUnitRow } from "@/server/repositories/packaging";

/**
 * The one implementation of "save and confirm a morning count", shared by the web app's Server Action and the phone app's
 * API route, so both clients get identical validation, identical server-side recomputation and identical conflict answers.
 * Callers have already checked that the person may write counts for `shopId`; the database checks it again.
 */
type Supa = Awaited<ReturnType<typeof createClient>>;
export interface CountContext { supabase: Supa; shopId: string }

export const countInputSchema = z.object({
  businessDate: z.string().refine(isBusinessDate),
  revision: z.number().int().min(0).nullable(),
  items: z.array(z.object({
    variantId: z.string().uuid(),
    entries: z.array(z.object({ unitId: z.string().uuid().nullable(), quantity: z.string().max(24) })).max(12),
  })).max(5000),
});
// Compile-time guarantee that the validation schema and the shared CountInput type describe exactly the same shape.
type SchemaMatchesType = z.infer<typeof countInputSchema> extends CountInput ? (CountInput extends z.infer<typeof countInputSchema> ? true : never) : never;
const _schemaMatchesType: SchemaMatchesType = true;
void _schemaMatchesType;

export const idempotencyKeySchema = z.string().min(8).max(100);

interface SubmitResponse {
  status: "confirmed" | "saved" | "conflict";
  replayed?: boolean;
  reason?: CountConflict["reason"];
  session_id?: string; revision?: number; counted?: number;
  server?: { session_id: string; revision: number; status: "draft" | "confirmed"; by: string | null; confirmed_at: string | null; lines: { variant_id: string; quantity: string }[] } | null;
}

const DB_CODES = [
  "MISSING_COUNTS", "NO_COUNTS", "FUTURE_DATE", "COUNT_OUT_OF_ORDER", "ALREADY_CONFIRMED", "INVALID_VARIANT", "INVALID_PAYLOAD",
] as const;

/** Map a database error to a translatable message without leaking internals. */
export function countFailure(err: { code?: string; message?: string } | null): CountResult {
  const text = err?.message ?? "";
  if (/REVISION_CONFLICT/.test(text)) return { ok: false, error: "ms.conflict", conflict: true };
  if (/FORBIDDEN/.test(text)) return { ok: false, error: "error.forbidden" };
  const code = DB_CODES.find((c) => text.includes(c));
  return { ok: false, error: code ? (`ms.err.${code}` as MessageKey) : "auth.error.generic" };
}

/**
 * Recompute every line on the server from the variant's stored packaging. The client's totals are
 * only a preview; what gets stored is what this function derives.
 */
export async function buildCountLines(ctx: CountContext, items: CountInput["items"]) {
  const ids = items.map((i) => i.variantId);
  const variants = new Map<string, { base: string; units: PackagingUnitRow[] }>();
  for (let i = 0; i < ids.length; i += 100) {
    const { data, error } = await ctx.supabase
      .from("product_variants")
      .select("id,base_inventory_unit,packaging_units(id,variant_id,name,parent_unit_id,conversion_factor,base_unit_multiplier,is_active,can_be_counted)")
      .eq("shop_id", ctx.shopId).in("id", ids.slice(i, i + 100));
    if (error) throw new Error("QUERY_FAILED");
    for (const v of (data ?? []) as unknown as { id: string; base_inventory_unit: string; packaging_units: PackagingUnitRow[] }[]) {
      variants.set(v.id, { base: v.base_inventory_unit, units: v.packaging_units });
    }
  }

  const lines: { variant_id: string; normalized_base_quantity: string; entry_details: unknown }[] = [];
  const itemErrors: Record<string, NormalizeError> = {};
  for (const item of items) {
    const v = variants.get(item.variantId);
    if (!v) { itemErrors[item.variantId] = "unknown_unit"; continue; } // not in this shop
    const units = v.units.filter((u) => u.is_active).map(toPackUnit);
    // A unit that is not used in stock counts is refused even if an old draft or a modified client sends it.
    if (item.entries.some((e) => e.unitId && units.find((u) => u.id === e.unitId)?.countable === false)) { itemErrors[item.variantId] = "unknown_unit"; continue; }
    const r = normalizePackagingQuantity(item.entries.map((e) => ({ unitId: e.unitId, quantity: e.quantity })), units, v.base);
    if (!r.ok) { itemErrors[item.variantId] = r.code; continue; }
    if (!r.counted) continue; // blank = not counted
    lines.push({ variant_id: item.variantId, normalized_base_quantity: r.baseQuantity, entry_details: buildEntryDetails(units, v.base, r.lines) });
  }
  return { lines, itemErrors };
}

export function countConflictResult(r: SubmitResponse): CountResult {
  const s = r.server;
  return {
    ok: false,
    error: r.reason === "already_confirmed" ? "ms.conflictConfirmed" : "ms.conflict",
    conflict: true,
    conflictInfo: {
      reason: r.reason ?? "revision",
      server: s ? { sessionId: s.session_id, revision: s.revision, status: s.status, by: s.by, confirmedAt: s.confirmed_at, lines: s.lines.map((l) => ({ variantId: l.variant_id, quantity: l.quantity })) } : null,
    },
  };
}

/** Save a draft (no confirmation). Used by the web form's autosave. */
export async function saveCountDraftCore(ctx: CountContext, input: CountInput): Promise<CountResult> {
  const { lines, itemErrors } = await buildCountLines(ctx, input.items);
  if (Object.keys(itemErrors).length) return { ok: false, error: "ms.err.INVALID_ITEMS", itemErrors };
  const { data, error } = await ctx.supabase.rpc("save_count_draft", {
    p_shop: ctx.shopId, p_date: input.businessDate, p_lines: lines, p_revision: input.revision,
  });
  if (error) return countFailure(error);
  const r = data as { session_id: string; revision: number; counted: number };
  return { ok: true, sessionId: r.session_id, revision: r.revision, counted: r.counted };
}

/**
 * Save the entries and confirm them in ONE database transaction, keyed by `idempotencyKey`.
 *  - Retrying with the same key (a lost response, a double tap, a queued offline submission replayed) returns the
 *    original answer and applies nothing twice.
 *  - If another device got there first, nothing is overwritten: the result is a conflict that carries the server's copy.
 * The caller must generate one key per distinct request.
 */
export async function submitCountCore(ctx: CountContext, raw: unknown, ackMissing: boolean, idempotencyKey: unknown, device?: string): Promise<CountResult> {
  const parsed = countInputSchema.safeParse(raw);
  const key = idempotencyKeySchema.safeParse(idempotencyKey);
  if (!parsed.success || !key.success) return { ok: false, error: "ms.err.INVALID_PAYLOAD" };

  const { lines, itemErrors } = await buildCountLines(ctx, parsed.data.items);
  if (Object.keys(itemErrors).length) return { ok: false, error: "ms.err.INVALID_ITEMS", itemErrors };

  const { data, error } = await ctx.supabase.rpc("submit_count", {
    p_shop: ctx.shopId, p_date: parsed.data.businessDate, p_lines: lines, p_base_revision: parsed.data.revision,
    p_key: key.data, p_confirm: true, p_ack_missing: ackMissing, p_device: device?.slice(0, 100) ?? null,
  });
  if (error) return countFailure(error);
  const r = data as SubmitResponse;
  if (r.status === "conflict") return countConflictResult(r);

  // The database reconciled the previous day inside the same transaction; report what it wrote.
  const salesDate = salesDateFor(parsed.data.businessDate);
  let sales: SalesSummary | undefined;
  try { sales = summarizeSales(salesDate, await getSalesForDate(ctx.supabase, ctx.shopId, salesDate)); } catch { sales = undefined; }
  return { ok: true, sessionId: r.session_id!, revision: r.revision!, counted: r.counted ?? 0, confirmed: true, alreadyConfirmed: !!r.replayed, sales };
}

/** Names for the conflict screen: the server's copy may hold products this device did not count. */
export async function variantLabels(ctx: CountContext, ids: unknown): Promise<Record<string, string>> {
  const parsed = z.array(z.string().uuid()).max(500).safeParse(ids);
  if (!parsed.success || parsed.data.length === 0) return {};
  const { data } = await ctx.supabase.from("product_variants").select("id,size_value,size_unit,products(name)").eq("shop_id", ctx.shopId).in("id", parsed.data);
  const out: Record<string, string> = {};
  for (const v of (data ?? []) as unknown as { id: string; size_value: string | null; size_unit: string | null; products: { name: string } | null }[]) {
    out[v.id] = [v.products?.name ?? "", sizeLabel(v.size_value, v.size_unit)].filter(Boolean).join(" ");
  }
  return out;
}
