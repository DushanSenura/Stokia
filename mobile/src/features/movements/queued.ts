import type { MovementDraft } from "@/features/movements/phone-types";
import { nowLocalInput } from "@/lib/dates/business";
import { shopLocalDate } from "@/lib/dates/format";
import type { MovementAnswer, QueuedMovement } from "@/lib/offline/movement-queue";
import { baseQuantity, effectOf, unitOptions, type FormState } from "./form";

/**
 * Pure rules for a movement that has to wait on the phone before it is sent.
 *
 * WHEN a movement happened decides which counting interval, so which day's sales, it affects. The phone cannot send it now, so it
 * fixes the moment at the time of entry rather than letting the server use the (later) time of sending:
 *  - "just now"           becomes a chosen time: the shop-local minute it was entered;
 *  - "before this count"  keeps meaning "before the count of the morning it was entered", and says which morning;
 *  - a chosen time        is left alone.
 */
export function queuedDraft(draft: MovementDraft, timezone: string, enteredAt: Date): MovementDraft {
  if (draft.when === "now") return { ...draft, when: "custom", effectiveLocal: nowLocalInput(timezone, enteredAt) };
  if (draft.when === "before_count") return { ...draft, countDate: draft.countDate ?? shopLocalDate(enteredAt, timezone) };
  return draft;
}

/** What the "waiting to send" list shows for this entry. */
export function summaryOf(f: FormState): QueuedMovement["summary"] {
  if (!f.item) throw new Error("NO_PRODUCT");
  const base = baseQuantity(f.item, f.unitId, f.quantity);
  const effect = effectOf(f.type, f.direction, base);
  if (base === null || effect === null) throw new Error("INCOMPLETE");
  const unit = unitOptions(f.item).find((u) => u.id === f.unitId)?.label ?? f.item.baseUnit;
  return {
    label: [f.item.productName, f.item.size].filter(Boolean).join(" "),
    baseUnit: f.item.baseUnit,
    effect,
    entered: `${f.quantity.trim()} ${unit}`,
  };
}

/**
 * "Before the count" is refused when that morning's count is not on the server yet. If the count is itself still waiting on this
 * phone, the movement should wait for it (the count is sent first), not fail. `waitingCountDates` are the mornings with a queued count.
 */
export function waitsForCount(entry: QueuedMovement, answer: Extract<MovementAnswer, { ok: false }>, waitingCountDates: string[], todayOf: (at: number) => string): boolean {
  if (entry.payload.when !== "before_count") return false;
  if (answer.fieldErrors?.when !== "mv.err.noCountToday") return false;
  const date = entry.payload.countDate ?? todayOf(entry.createdAt);
  return waitingCountDates.includes(date);
}
