import type { SellableUnit } from "@/lib/calculations/sales-breakdown";

/**
 * Pure types (no server imports): what the sales-breakdown screens receive and send. Shared by the web app, the phone app and the API.
 * See src/lib/calculations/sales-breakdown.ts for the rule.
 */

/** One line of a recorded breakdown. `unitId` null / `isBaseUnit` true = the base unit (the loose pieces). */
export interface BreakdownLineView {
  unitId: string | null;
  isBaseUnit: boolean;
  name: string;
  quantity: string;
  baseUnits: string;
  unitPrice: string;
  amount: string;
}

export interface BreakdownCurrent {
  revision: number;
  /** stale: a count was corrected and the boxes no longer fit the new inferred figure. Kept, not used. */
  status: "active" | "stale";
  inferred: string;
  packaged: string;
  remainder: string;
  amount: string | null;
  note: string | null;
  updatedAt: string;
  lines: BreakdownLineView[];
}

/** A product for which a day's sales can be split (it has a sellable packaging unit, or a breakdown was already recorded). */
export interface BreakdownItem {
  variantId: string;
  name: string;
  size: string;
  sku: string;
  baseUnit: string;
  /** Inferred base units sold on that day (always a calculated figure; days without one are not offered). */
  inferred: string;
  /** known: a breakdown is in use. stale: one exists but no longer fits. unknown: none recorded. */
  packagingStatus: "unknown" | "known" | "stale";
  /** The day's estimated sales as stored now (the known split when known, otherwise the plain estimate). */
  amount: string | null;
  /** inferred x base price: what the day is worth if the packaging mix is not known. */
  plainEstimate: string | null;
  base: { name: string; sellable: boolean; price: string | null };
  /** The sellable packaging units with the price in force on that day (a unit without one is listed with price null). */
  units: SellableUnit[];
  current: BreakdownCurrent | null;
}

export interface BreakdownDay {
  /** The sales date (the day BEFORE the count that closed it). */
  date: string;
  items: BreakdownItem[];
  /** Products that could take a breakdown but have no calculated figure for that day yet. */
  unavailable: number;
  /** The day's Estimated Sales across ALL products (known splits included), so a screen showing that total can update it after a change. */
  estimatedTotal: string;
}

export interface BreakdownHistoryEntry {
  revision: number;
  action: "created" | "updated" | "cleared" | "recalculated" | "marked_stale" | "restored";
  reason: string | null;
  at: string;
  /** null for the system's own recalculation */
  by: string | null;
  amount: string | null;
  packaged: string | null;
  lines: BreakdownLineView[];
}

export interface BreakdownDraft {
  variantId: string;
  date: string;
  lines: { unitId: string; quantity: string }[];
  /** Required when changing a breakdown that already exists. */
  reason?: string;
  /** The revision the person was looking at; a different one means someone changed it meanwhile. */
  expectedRevision?: number | null;
}

export type BreakdownResponse =
  | { ok: true; duplicate: boolean; revision: number; amount?: string }
  | { ok: false; error?: string; /** keyed by packaging unit id when a line is at fault */ fieldErrors?: Record<string, string> };
