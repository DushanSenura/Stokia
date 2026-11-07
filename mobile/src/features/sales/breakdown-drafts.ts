/**
 * Drafts of the sales breakdown typed on the phone. They are kept as the person types, so closing the app or losing the signal never loses
 * what they entered. A draft is NOT a saved breakdown and is never sent by itself: only pressing Save with a connection sends it, and
 * only the server's answer makes anything recorded. Under the `draft.` prefix, which signing out removes.
 */
export interface BreakdownDraftState {
  /** The revision on the server when this draft was started (0 = none recorded). A different revision now means someone changed it. */
  base: number;
  qty: Record<string, string>;
  reason: string;
  savedAt: number;
}

export const breakdownDraftKey = (scope: string, date: string, variantId: string) => `draft.breakdown.${scope}.${date}.${variantId}`;

/** A saved draft is only offered again if it still applies to the revision on the server and holds something. */
export function usableDraft(saved: BreakdownDraftState | null | undefined, serverRevision: number): BreakdownDraftState | null {
  if (!saved || saved.base !== serverRevision) return null;
  const typed = Object.values(saved.qty).some((v) => v.trim() !== "") || saved.reason.trim() !== "";
  return typed ? saved : null;
}

/** The state to store for a draft, stamped with the time it was kept. */
export const newDraft = (base: number, qty: Record<string, string>, reason: string): BreakdownDraftState => ({ base, qty, reason, savedAt: Date.now() });
