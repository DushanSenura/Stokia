import type { MovementType } from "@/lib/calculations/reconcile";

/** Pure types (no server imports): what the phone's Movements screen receives and sends. Shared by the API and the app. */

/** One recorded movement, as the phone lists it. */
export interface PhoneMovement {
  id: string;
  type: MovementType;
  /** Product and size, e.g. "Chilli Powder 250 g". */
  label: string;
  sku: string;
  baseUnit: string;
  /** The SIGNED effect on stock in the base unit (negative = stock left). */
  effect: string;
  /** What the person entered, e.g. "3 Bundle". */
  entered: string;
  effectiveAt: string;
  createdAt: string;
  reason: string | null;
  reference: string | null;
  supplier: string | null;
  by: string | null;
  /** A later entry already cancelled this one. */
  reversed: boolean;
  /** This entry IS a reversal of another. */
  isReversal: boolean;
  /** Safe to offer "reverse": not already reversed, not itself a reversal, and not one half of a repacking. */
  canReverse: boolean;
}

/** The movement types a person may record directly (repacking touches two products and stays on the web). */
export const PHONE_MOVEMENT_TYPES = ["stock_received", "customer_return", "supplier_return", "damaged", "expired", "discarded", "manual_adjustment"] as const;
export type PhoneMovementType = (typeof PHONE_MOVEMENT_TYPES)[number];

/** When the stock moved: after today's count (the default), or already on the shelf when today's count was taken. */
export type MovementWhen = "now" | "before_count";

/**
 * What is actually sent. The form only offers the two above; "custom" is what a movement saved offline becomes, with the moment it
 * was entered, so sending it hours later still lands at the right time.
 */
export type SentWhen = MovementWhen | "custom";

/** What the phone sends to record a movement. `quantity` is a plain decimal string in `unitId` (or the base unit if null). */
export interface MovementDraft {
  variantId: string;
  type: PhoneMovementType;
  /** Only used by "manual adjustment", where the person chooses whether stock is added or removed. */
  direction?: "in" | "out";
  unitId: string | null;
  quantity: string;
  when: SentWhen;
  /** Shop-local "YYYY-MM-DDTHH:mm", with `when: "custom"`. */
  effectiveLocal?: string;
  /** The morning ("YYYY-MM-DD") a "before_count" movement belongs to; omitted means today. */
  countDate?: string;
  reason?: string;
  reference?: string;
  supplier?: string;
  cost?: string;
}

export type MovementResponse =
  | { ok: true; id: string; duplicate: boolean }
  | { ok: false; error?: string; fieldErrors?: Record<string, string> };
