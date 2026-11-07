import type { MessageKey } from "@/i18n";
import type { NormalizeError } from "@/lib/calculations/packaging";

/**
 * The shapes a morning count travels in, between the web app, the phone app and the server. Pure types only (no React,
 * Next.js or server imports), so every client can share them and the contract cannot drift.
 */

/** What a device sends: only the rows the person filled in (blank = not counted). */
export interface CountInput {
  businessDate: string;
  /** The server revision this device last saw (null = it believes no session exists yet). */
  revision: number | null;
  items: { variantId: string; entries: { unitId: string | null; quantity: string }[] }[];
}

export interface SalesSummary {
  date: string; calculated: number; needsReview: number; pending: number; estimatedTotal: string; unitsByBaseUnit: Record<string, string>;
}

/** What the server holds for that morning when a submission conflicts with it. Nothing was overwritten. */
export interface CountConflict {
  reason: "revision" | "already_confirmed";
  server: { sessionId: string; revision: number; status: "draft" | "confirmed"; by: string | null; confirmedAt: string | null; lines: { variantId: string; quantity: string }[] } | null;
}

export type CountResult =
  | { ok: true; sessionId: string; revision: number; counted: number; confirmed?: boolean; alreadyConfirmed?: boolean; sales?: SalesSummary }
  | { ok: false; error: MessageKey; conflict?: boolean; conflictInfo?: CountConflict; itemErrors?: Record<string, NormalizeError> };
