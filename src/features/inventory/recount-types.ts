import type { MessageKey } from "@/i18n";
import type { NormalizeError } from "@/lib/calculations/packaging";

/**
 * Pure types (no server imports) for "another stock sheet on the same day": a stock manager asks, the owner approves, only the person
 * who asked can then use it. Shared by the web app, the phone app and the API.
 */
export type RecountStatus = "pending" | "approved" | "rejected" | "cancelled" | "used";

export interface RecountRequestView {
  id: string;
  status: RecountStatus;
  reason: string;
  requestedBy: string;
  requestedByName: string | null;
  createdAt: string;
  decidedAt: string | null;
  decidedByName: string | null;
  decisionNote: string | null;
  usedAt: string | null;
  changedLines: number | null;
  /** The request belongs to the signed-in person. */
  mine: boolean;
}

export interface RecountState {
  sessionId: string;
  businessDate: string;
  /** Requests only work for the shop's CURRENT date; older days go through ordinary corrections. */
  isToday: boolean;
  /** The signed-in person's latest request for this sheet (an open one first). */
  mine: RecountRequestView | null;
  /** Owner only: requests waiting for a decision. */
  waiting: RecountRequestView[];
  /** May ask for another stock sheet right now. */
  canRequest: boolean;
}

export type RecountAnswer =
  | { ok: true; id?: string; status?: RecountStatus; changed?: number; duplicate?: boolean }
  | { ok: false; error: MessageKey; itemErrors?: Record<string, NormalizeError> };
