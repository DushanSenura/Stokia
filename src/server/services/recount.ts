import "server-only";
import { valuesFromLine, type EntryItem, type FieldValues } from "@/features/inventory/count-entry";
import type { CountInput } from "@/features/inventory/count-types";
import type { RecountAnswer, RecountRequestView, RecountState, RecountStatus } from "@/features/inventory/recount-types";
import { shopLocalDate } from "@/lib/dates/format";
import type { createClient } from "@/lib/supabase/server";
import type { MessageKey } from "@/i18n";
import { getLines, loadEntryItems } from "@/server/repositories/inventory";
import { buildCountLines, countInputSchema } from "@/server/services/count-submit";
import type { Role } from "@/server/permissions";

/**
 * Another stock sheet on the same day: the rules live in the database (migration ..._same_day_recounts.sql): who may ask, that only the
 * owner decides, that only the person who asked can use it, that it only works on its own day, and that nothing is deleted (every changed
 * figure stays in the correction history). This file asks the questions and turns the answers into messages.
 */
type Supa = Awaited<ReturnType<typeof createClient>>;
export interface RecountContext { supabase: Supa; shopId: string; userId: string; role: Role; timezone: string }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CODES = [
  "NOT_FOUND", "NOT_CONFIRMED", "REASON_REQUIRED", "NOT_TODAY", "ALREADY_OPEN", "NOT_PENDING", "NOTE_REQUIRED", "EXPIRED", "NOT_OPEN",
  "NOT_APPROVED", "ALREADY_USED", "NO_LINES", "INVALID_LINE", "DUPLICATE_LINE", "INVALID_VARIANT", "NO_CHANGE", "KEY_REQUIRED", "IDEMPOTENCY_MISMATCH",
] as const;

/** A database error as a translatable message, without leaking internals. */
export function recountError(err: { message?: string } | null): MessageKey {
  const text = err?.message ?? "";
  if (/FORBIDDEN/.test(text)) return "error.forbidden";
  const c = CODES.find((x) => text.includes(x));
  return c ? (`rc.err.${c}` as MessageKey) : "auth.error.generic";
}

interface Row {
  id: string; status: RecountStatus; reason: string; requested_by: string; created_at: string; decided_at: string | null; decided_by: string | null;
  decision_note: string | null; used_at: string | null; changed_lines: number | null;
}

/** The state of the extra-stock-sheet question for one confirmed sheet, as the signed-in person may see it. */
export async function loadRecountState(ctx: RecountContext, sessionId: string, businessDate: string): Promise<RecountState> {
  const isToday = businessDate === shopLocalDate(new Date(), ctx.timezone);
  const { data, error } = await ctx.supabase.from("recount_requests")
    .select("id,status,reason,requested_by,created_at,decided_at,decided_by,decision_note,used_at,changed_lines")
    .eq("session_id", sessionId).order("created_at", { ascending: false }).limit(50); // row-level security already limits a stock manager to their own
  if (error) throw new Error("RECOUNT_QUERY_FAILED");
  const rows = (data ?? []) as unknown as Row[];

  const ids = [...new Set(rows.flatMap((r) => [r.requested_by, r.decided_by]).filter((x): x is string => !!x))];
  const names = new Map<string, string>();
  if (ids.length) {
    const { data: people } = await ctx.supabase.from("user_profiles").select("id,display_name").in("id", ids);
    for (const p of (people ?? []) as { id: string; display_name: string }[]) names.set(p.id, p.display_name);
  }
  const view = (r: Row): RecountRequestView => ({
    id: r.id, status: r.status, reason: r.reason, requestedBy: r.requested_by, requestedByName: names.get(r.requested_by) ?? null, createdAt: r.created_at,
    decidedAt: r.decided_at, decidedByName: r.decided_by ? names.get(r.decided_by) ?? null : null, decisionNote: r.decision_note, usedAt: r.used_at,
    changedLines: r.changed_lines, mine: r.requested_by === ctx.userId,
  });

  const mineRows = rows.filter((r) => r.requested_by === ctx.userId);
  const mine = mineRows.find((r) => r.status === "pending" || r.status === "approved") ?? mineRows[0] ?? null;
  const open = !!mine && (mine.status === "pending" || mine.status === "approved");
  return {
    sessionId, businessDate, isToday,
    mine: mine ? view(mine) : null,
    waiting: ctx.role === "owner" ? rows.filter((r) => r.status === "pending" && r.requested_by !== ctx.userId).map(view) : [],
    canRequest: isToday && (ctx.role === "owner" || ctx.role === "stock_manager") && !open,
  };
}

export async function requestRecountCore(ctx: RecountContext, sessionId: string, reason: string): Promise<RecountAnswer> {
  if (!UUID.test(sessionId)) return { ok: false, error: "auth.error.generic" };
  const { data, error } = await ctx.supabase.rpc("request_recount", { p_session: sessionId, p_reason: String(reason ?? "").trim().slice(0, 300) });
  if (error) return { ok: false, error: recountError(error) };
  const r = data as { id: string; status: RecountStatus };
  return { ok: true, id: r.id, status: r.status };
}

export async function decideRecountCore(ctx: RecountContext, id: string, approve: boolean, note: string): Promise<RecountAnswer> {
  if (!UUID.test(id)) return { ok: false, error: "auth.error.generic" };
  const { data, error } = await ctx.supabase.rpc("decide_recount", { p_id: id, p_approve: approve === true, p_note: String(note ?? "").trim().slice(0, 300) });
  if (error) return { ok: false, error: recountError(error) };
  return { ok: true, id, status: (data as { status: RecountStatus }).status };
}

export async function cancelRecountCore(ctx: RecountContext, id: string): Promise<RecountAnswer> {
  if (!UUID.test(id)) return { ok: false, error: "auth.error.generic" };
  const { error } = await ctx.supabase.rpc("cancel_recount", { p_id: id });
  if (error) return { ok: false, error: recountError(error) };
  return { ok: true, id, status: "cancelled" };
}

/**
 * The figures of the approved recount. Quantities are worked out HERE from the stored packaging (the browser's totals are only a
 * preview), exactly as for the morning count; the database re-checks who may use it, when, and that something really changed.
 */
export async function submitRecountCore(ctx: RecountContext, requestId: string, raw: unknown, key: string): Promise<RecountAnswer> {
  if (!UUID.test(requestId)) return { ok: false, error: "auth.error.generic" };
  if (typeof key !== "string" || key.trim().length < 8 || key.length > 80) return { ok: false, error: "rc.err.KEY_REQUIRED" };
  const parsed = countInputSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: "auth.error.generic" };
  const input: CountInput = parsed.data;

  const built = await buildCountLines({ supabase: ctx.supabase, shopId: ctx.shopId }, input.items);
  if (Object.keys(built.itemErrors).length > 0) return { ok: false, error: "ms.fixErrors", itemErrors: built.itemErrors };
  if (built.lines.length === 0) return { ok: false, error: "rc.err.NO_LINES" };

  const { data, error } = await ctx.supabase.rpc("submit_recount", {
    p_request: requestId, p_key: key,
    p_lines: built.lines.map((l) => ({ variant_id: l.variant_id, normalized_base_quantity: Number(l.normalized_base_quantity), entry_details: l.entry_details })),
  });
  if (error) return { ok: false, error: recountError(error) };
  const r = data as { duplicate: boolean; changed: number };
  return { ok: true, id: requestId, status: "used", changed: r.changed, duplicate: r.duplicate };
}

export interface RecountSheet {
  businessDate: string;
  items: EntryItem[];
  /** The figures of the sheet as it stands now, to start from. */
  initialValues: Record<string, FieldValues>;
  /** The quantity (base unit) each product has now, to show what would change. */
  currentBase: Record<string, string>;
  truncated: boolean;
}

/**
 * The sheet to recount: today's products with the counted figures already in them. Only the person the owner approved gets it (the
 * database is asked again when they submit; this check keeps the form from opening for anybody else).
 */
export async function loadRecountSheet(ctx: RecountContext, requestId: string): Promise<RecountSheet | null> {
  if (!UUID.test(requestId)) return null;
  const { data: r } = await ctx.supabase.from("recount_requests").select("id,status,requested_by,session_id,business_date").eq("id", requestId).maybeSingle();
  const req = r as { status: string; requested_by: string; session_id: string; business_date: string } | null;
  if (!req || req.status !== "approved" || req.requested_by !== ctx.userId) return null;
  if (req.business_date !== shopLocalDate(new Date(), ctx.timezone)) return null; // an approval only lasts for its own day

  const { items, truncated } = await loadEntryItems(ctx.supabase, ctx.shopId, req.business_date, ctx.timezone);
  const initialValues: Record<string, FieldValues> = {};
  const currentBase: Record<string, string> = {};
  const byId = new Map(items.map((i) => [i.variantId, i]));
  for (const line of await getLines(ctx.supabase, req.session_id)) {
    const item = byId.get(line.variant_id);
    if (!item || line.count_status !== "counted") continue;
    initialValues[line.variant_id] = valuesFromLine(item, line);
    currentBase[line.variant_id] = String(Number(line.normalized_base_quantity));
  }
  return { businessDate: req.business_date, items, initialValues, currentBase, truncated };
}
