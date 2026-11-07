import { computeBreakdown, breakdownErrorKey, type BreakdownResult } from "@/lib/calculations/sales-breakdown";
import type { BreakdownDraft, BreakdownItem } from "./breakdown-types";
import type { MessageKey } from "@/i18n";

/**
 * The logic of the sales-breakdown form, with no screen in it. The web panel and the phone screen both call exactly these functions,
 * so what the person sees (preview, errors, whether Save is allowed) is the same on both. The server validates everything again.
 */

/** Digits only: whole packages, nothing else is typed into the boxes. */
export const isWholeNumber = (v: string): boolean => /^\d{0,9}$/.test(v);

/** The units the form shows: sellable and active, plus any unit that an existing breakdown already uses. */
export const formUnits = (item: BreakdownItem) =>
  item.units.filter((u) => u.isActive !== false || item.current?.lines.some((l) => l.unitId === u.id));

/** The boxes as they are currently recorded (blank where nothing is recorded), to start the form from. */
export function startingQuantities(item: BreakdownItem): Record<string, string> {
  return Object.fromEntries(formUnits(item).map((u) => [u.id, item.current?.lines.find((l) => l.unitId === u.id)?.quantity ?? ""]));
}

/** Only the boxes the person actually typed: an empty box means "I do not know", not zero. */
export function enteredLines(item: BreakdownItem, qty: Record<string, string>): { unitId: string; quantity: string }[] {
  return formUnits(item).filter((u) => (qty[u.id] ?? "").trim() !== "").map((u) => ({ unitId: u.id, quantity: qty[u.id].trim() }));
}

export interface Preview {
  /** Has anything been typed? When not, the day stays an estimate with unknown packaging. */
  entered: boolean;
  result: BreakdownResult;
}

/** The live preview, from the same rule the database applies. */
export function previewBreakdown(item: BreakdownItem, qty: Record<string, string>): Preview {
  const lines = enteredLines(item, qty);
  return { entered: lines.length > 0, result: computeBreakdown({ inferred: item.inferred, lines, units: item.units, base: item.base, requireActive: true }) };
}

/** True when what is typed equals what is recorded (so there is nothing to save). */
export function sameAsRecorded(item: BreakdownItem, qty: Record<string, string>): boolean {
  if (!item.current) return false;
  const typed = enteredLines(item, qty);
  const recorded = item.current.lines.filter((l) => !l.isBaseUnit);
  return typed.length === recorded.length && typed.every((l) => recorded.find((r) => r.unitId === l.unitId)?.quantity === String(Number(l.quantity)));
}

export type SaveCheck = { ok: true; draft: BreakdownDraft } | { ok: false; error: MessageKey };

/** Can this be saved? A change to an existing breakdown needs a reason; the numbers must fit the day. */
export function checkSave(item: BreakdownItem, date: string, qty: Record<string, string>, reason: string): SaveCheck {
  if (item.current && !reason.trim()) return { ok: false, error: "sb.err.REASON_REQUIRED" };
  // An empty box means "I do not know", so nothing typed is not a breakdown. A typed 0 is a known zero; "I do not know after all" removes one.
  if (enteredLines(item, qty).length === 0) return { ok: false, error: "sb.err.INVALID_LINE" };
  const { result } = previewBreakdown(item, qty);
  if (!result.ok) return { ok: false, error: breakdownErrorKey(result.error) };
  return {
    ok: true,
    draft: { variantId: item.variantId, date, lines: enteredLines(item, qty), reason: reason.trim() || undefined, expectedRevision: item.current?.revision ?? null },
  };
}

/** Removing a breakdown ("I do not know after all") always needs a reason. */
export const checkClear = (reason: string): { ok: true } | { ok: false; error: MessageKey } =>
  reason.trim() ? { ok: true } : { ok: false, error: "sb.err.REASON_REQUIRED" };

/** Whether the Save button should be enabled. */
export function canPressSave(item: BreakdownItem, qty: Record<string, string>): boolean {
  const { entered } = previewBreakdown(item, qty);
  if (!entered) return false;                              // nothing typed is never a breakdown
  if (!item.current) return true;
  return !(sameAsRecorded(item, qty) && item.packagingStatus !== "stale"); // recorded: needs a change (or a stale one to confirm)
}

/** What the day is worth with the typed boxes (known), or the plain estimate when nothing is typed. */
export function revenueOf(item: BreakdownItem, qty: Record<string, string>): { kind: "known"; amount: string } | { kind: "estimate"; amount: string | null } | { kind: "invalid"; error: MessageKey } {
  const p = previewBreakdown(item, qty);
  if (!p.entered) return { kind: "estimate", amount: item.plainEstimate };
  return p.result.ok ? { kind: "known", amount: p.result.amount } : { kind: "invalid", error: breakdownErrorKey(p.result.error) };
}
