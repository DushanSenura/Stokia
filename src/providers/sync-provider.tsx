"use client";

import { useRouter } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useToast } from "@/components/ui/toast";
import { formatBusinessDate } from "@/lib/dates/business";
import { saveLocalDraft } from "@/lib/offline/draft-store";
import {
  deviceLabel, draftValuesFromPayload, enqueueConflict, enqueueCount, isBlocked, listQueued, removeQueued, resubmitOnTopOfServer, retryQueued, syncQueue,
  type EnqueueResult, type NewQueuedCount, type QueuedCount,
} from "@/lib/offline/sync-queue";
import { confirmCountAction, type CountConflict } from "@/server/actions/inventory";
import type { MessageKey } from "@/i18n";
import { useI18n } from "./i18n-provider";

const RETRY_EVERY_MS = 15_000;

function subscribeOnline(cb: () => void) {
  window.addEventListener("online", cb);
  window.addEventListener("offline", cb);
  return () => { window.removeEventListener("online", cb); window.removeEventListener("offline", cb); };
}

export interface SyncApi {
  /** Counts waiting on this device (pending, in conflict, or failed), oldest morning first. */
  entries: QueuedCount[];
  online: boolean;
  syncing: boolean;
  enqueue: (input: NewQueuedCount) => Promise<EnqueueResult>;
  /** Keep this device's numbers next to the server's copy after a live conflict. */
  recordConflict: (input: NewQueuedCount, error: MessageKey, conflict: CountConflict | undefined) => Promise<EnqueueResult>;
  syncNow: () => Promise<void>;
  /** "Use my numbers": resend on top of the server's current revision. */
  keepMine: (id: string) => Promise<void>;
  /** "Keep the server's numbers": drop this device's copy. */
  discard: (id: string) => Promise<void>;
  retry: (id: string) => Promise<void>;
  /** Put the numbers back into the form fields and remove the queue entry; resolves to the morning's date. */
  editAgain: (id: string) => Promise<string | null>;
}

const unavailable: SyncApi = {
  entries: [], online: true, syncing: false,
  enqueue: async () => ({ ok: false, reason: "unavailable" }),
  recordConflict: async () => ({ ok: false, reason: "unavailable" }),
  syncNow: async () => {}, keepMine: async () => {}, discard: async () => {}, retry: async () => {}, editAgain: async () => null,
};
const Ctx = createContext<SyncApi>(unavailable);

/** Works without a provider (previews, tests): then nothing can be queued and callers fall back to showing an error. */
export const useSync = () => useContext(Ctx);

export function SyncProvider({ scope, children }: { scope: string; children: React.ReactNode }) {
  const router = useRouter();
  const toast = useToast();
  const { t, locale } = useI18n();
  const [entries, setEntries] = useState<QueuedCount[]>([]);
  const online = useSyncExternalStore(subscribeOnline, () => navigator.onLine, () => true);
  const [syncing, setSyncing] = useState(false);
  const alive = useRef(true);

  const refresh = useCallback(async () => {
    const list = await listQueued(scope);
    if (alive.current) setEntries(list);
    return list;
  }, [scope]);

  const syncNow = useCallback(async () => {
    if (typeof navigator !== "undefined" && navigator.onLine === false) return;
    if (alive.current) setSyncing(true);
    try {
      const outcome = await syncQueue(scope, (e) => confirmCountAction(e.payload, e.ack, e.key, deviceLabel()));
      await refresh();
      for (const c of outcome.confirmed) toast(t("sync.confirmedToast", { date: formatBusinessDate(c.businessDate, locale) }));
      if (outcome.confirmed.length) router.refresh();
    } finally {
      if (alive.current) setSyncing(false);
    }
  }, [scope, refresh, toast, t, locale, router]);

  // Load what is waiting, and try to send it.
  useEffect(() => {
    alive.current = true;
    void refresh().then((list) => { if (list.some((e) => e.state === "pending")) void syncNow(); });
    return () => { alive.current = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only on mount / scope change
  }, [scope]);

  // Connection and focus changes.
  useEffect(() => {
    const up = () => { void syncNow(); };
    const visible = () => { if (document.visibilityState === "visible") void refresh().then((l) => { if (l.some((e) => e.state === "pending")) void syncNow(); }); };
    window.addEventListener("online", up);
    document.addEventListener("visibilitychange", visible);
    return () => { window.removeEventListener("online", up); document.removeEventListener("visibilitychange", visible); };
  }, [syncNow, refresh]);

  // While something is waiting, keep trying (the same idempotency key is replayed, so this is always safe).
  const hasSendable = entries.some((e) => e.state === "pending" && !isBlocked(entries, e));
  useEffect(() => {
    if (!hasSendable) return;
    const id = setInterval(() => void syncNow(), RETRY_EVERY_MS);
    return () => clearInterval(id);
  }, [hasSendable, syncNow]);

  const api = useMemo<SyncApi>(() => ({
    entries, online, syncing,
    enqueue: async (input) => {
      const r = await enqueueCount(input);
      if (r.ok) await refresh();
      return r;
    },
    recordConflict: async (input, error, conflict) => {
      const r = await enqueueConflict(input, error, conflict);
      if (r.ok) await refresh();
      return r;
    },
    syncNow,
    keepMine: async (id) => { await resubmitOnTopOfServer(id); await refresh(); await syncNow(); },
    discard: async (id) => { await removeQueued(id); await refresh(); router.refresh(); },
    retry: async (id) => { await retryQueued(id); await refresh(); await syncNow(); },
    editAgain: async (id) => {
      const e = entries.find((x) => x.id === id);
      if (!e) return null;
      await saveLocalDraft({ scope: e.scope, businessDate: e.businessDate, values: draftValuesFromPayload(e.payload.items), baseRevision: e.payload.revision });
      await removeQueued(id);
      await refresh();
      return e.businessDate;
    },
  }), [entries, online, syncing, syncNow, refresh, router]);

  return <Ctx.Provider value={api}>{children}</Ctx.Provider>;
}
