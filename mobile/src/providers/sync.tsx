import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { AppState } from "react-native";
import { draftValuesFromPayload, isBlocked, type EnqueueResult, type NewQueuedCount, type QueuedCount } from "@/lib/offline/queue-engine";
import type { CountConflict } from "@/features/inventory/count-types";
import { shopLocalDate } from "@/lib/dates/format";
import type { EnqueueMovementResult, MovementAnswer, NewQueuedMovement, QueuedMovement } from "@/lib/offline/movement-queue";
import { waitsForCount } from "~/features/movements/queued";
import { useSession } from "~/providers/session";
import type { MessageKey } from "@/i18n";
import { api } from "~/lib/api";
import { deviceLabel } from "~/lib/device";
import { kvSetJson } from "~/lib/kv";
import { useOnline } from "~/lib/use-online";
import { movementQueue } from "~/offline/movement-queue";
import { queue } from "~/offline/queue";

const RETRY_EVERY_MS = 15_000;
const NOTICE_MS = 6_000;

export interface SyncApi {
  /** Counts waiting on this phone (pending, in conflict, or failed), oldest morning first. */
  entries: QueuedCount[];
  online: boolean;
  syncing: boolean;
  /** Stock movements entered while offline that the server has not recorded yet (pending or refused), oldest first. */
  movementEntries: QueuedMovement[];
  enqueueMovement: (input: Omit<NewQueuedMovement, "scope">) => Promise<EnqueueMovementResult>;
  /** Remove a waiting movement. False if it may already have reached the server (it resolves when the answer arrives). */
  discardMovement: (id: string) => Promise<boolean>;
  retryMovement: (id: string) => Promise<void>;
  /** Bumps every time a queued count or movement is confirmed, so screens can reload their data. */
  confirmedRevision: number;
  /** A short-lived message ("Count for ... was sent and confirmed"). */
  notice: { date: string } | null;
  enqueue: (input: NewQueuedCount) => Promise<EnqueueResult>;
  recordConflict: (input: NewQueuedCount, error: MessageKey, conflict: CountConflict | undefined) => Promise<EnqueueResult>;
  syncNow: () => Promise<void>;
  /** Ask the screens that show the day's figures (Home, the stock success screen) to reload: something changed them (a sales breakdown). */
  refreshData: () => void;
  keepMine: (id: string) => Promise<void>;
  discard: (id: string) => Promise<void>;
  retry: (id: string) => Promise<void>;
  /** Put the numbers back into the saved on-phone draft and remove the queue entry; resolves to the morning's date. */
  editAgain: (id: string) => Promise<string | null>;
}

const Ctx = createContext<SyncApi | null>(null);
export const draftKey = (scope: string, date: string) => `draft.${scope}.${date}`;

/** Runs the shared offline-queue rules on the phone: sends waiting counts, with the same idempotency key, whenever it can. */
export function SyncProvider({ scope, children }: { scope: string; children: React.ReactNode }) {
  const online = useOnline();
  const { shop } = useSession();
  const timezone = shop?.timezone ?? "Asia/Colombo";
  const [entries, setEntries] = useState<QueuedCount[]>([]);
  const [movementEntries, setMovementEntries] = useState<QueuedMovement[]>([]);
  const [syncing, setSyncing] = useState(false);
  const [confirmedRevision, setConfirmedRevision] = useState(0);
  const [notice, setNotice] = useState<SyncApi["notice"]>(null);
  const alive = useRef(true);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const shopId = scope.split(":")[0];

  /** Reload both queues from storage. Resolves to true when something is waiting that can be sent. */
  const refresh = useCallback(async () => {
    const [list, movements] = await Promise.all([queue.listQueued(scope), movementQueue.list(scope)]);
    if (alive.current) { setEntries(list); setMovementEntries(movements); }
    return list.some((e) => e.state === "pending") || movements.some((m) => m.state === "pending");
  }, [scope]);

  const syncNow = useCallback(async () => {
    if (!online) return;
    if (alive.current) setSyncing(true);
    try {
      // Counts first: a movement "before the count" can only be recorded once that morning's count has reached the server.
      const outcome = await queue.syncQueue(scope, (e) => api.submitCount({ shopId, count: e.payload, ackMissing: e.ack, key: e.key, device: deviceLabel() }));
      const waitingCounts = (await queue.listQueued(scope)).filter((e) => e.state === "pending").map((e) => e.businessDate);
      const moved = await movementQueue.sync(
        scope,
        async (e) => (await api.recordMovement({ shopId, movement: e.payload, key: e.key })) as MovementAnswer, // the server's messages ARE message keys
        { shouldWait: (e, answer) => waitsForCount(e, answer, waitingCounts, (at) => shopLocalDate(new Date(at), timezone)) },
      );
      await refresh();
      if ((outcome.confirmed.length || moved.confirmed.length) && alive.current) setConfirmedRevision((n) => n + 1);
      if (outcome.confirmed.length && alive.current) {
        setNotice({ date: outcome.confirmed[outcome.confirmed.length - 1].businessDate });
        if (noticeTimer.current) clearTimeout(noticeTimer.current);
        noticeTimer.current = setTimeout(() => setNotice(null), NOTICE_MS);
      }
    } finally {
      if (alive.current) setSyncing(false);
    }
  }, [online, scope, shopId, timezone, refresh]);

  // Load what is waiting and try to send it; again whenever the connection returns or the app comes back to the foreground.
  useEffect(() => {
    alive.current = true;
    void refresh().then((send) => { if (send) void syncNow(); });
    const app = AppState.addEventListener("change", (s) => {
      if (s === "active") void refresh().then((send) => { if (send) void syncNow(); });
    });
    return () => { alive.current = false; app.remove(); if (noticeTimer.current) clearTimeout(noticeTimer.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per scope; reconnection is handled below
  }, [scope]);
  useEffect(() => { if (online) void refresh().then((send) => { if (send) void syncNow(); }); }, [online]); // eslint-disable-line react-hooks/exhaustive-deps

  // While something can be sent, keep trying (the same key is replayed, so this is always safe).
  const hasSendable = entries.some((e) => e.state === "pending" && !isBlocked(entries, e)) || movementEntries.some((m) => m.state === "pending");
  useEffect(() => {
    if (!hasSendable) return;
    const id = setInterval(() => void syncNow(), RETRY_EVERY_MS);
    return () => clearInterval(id);
  }, [hasSendable, syncNow]);

  const api_ = useMemo<SyncApi>(() => ({
    entries, movementEntries, online, syncing, confirmedRevision, notice,
    enqueueMovement: async (input) => { const r = await movementQueue.enqueue({ ...input, scope }); if (r.ok) await refresh(); return r; },
    discardMovement: async (id) => { const gone = await movementQueue.discard(id); await refresh(); return gone; },
    retryMovement: async (id) => { await movementQueue.retry(id); await refresh(); await syncNow(); },
    enqueue: async (input) => { const r = await queue.enqueueCount(input); if (r.ok) await refresh(); return r; },
    recordConflict: async (input, error, conflict) => { const r = await queue.enqueueConflict(input, error, conflict); if (r.ok) await refresh(); return r; },
    syncNow,
    refreshData: () => setConfirmedRevision((n) => n + 1),
    keepMine: async (id) => { await queue.resubmitOnTopOfServer(id); await refresh(); await syncNow(); },
    discard: async (id) => { await queue.removeQueued(id); await refresh(); setConfirmedRevision((n) => n + 1); },
    retry: async (id) => { await queue.retryQueued(id); await refresh(); await syncNow(); },
    editAgain: async (id) => {
      const e = entries.find((x) => x.id === id);
      if (!e) return null;
      await kvSetJson(draftKey(e.scope, e.businessDate), { values: draftValuesFromPayload(e.payload.items), baseRevision: e.payload.revision, savedAt: Date.now() });
      await queue.removeQueued(id);
      await refresh();
      return e.businessDate;
    },
  }), [entries, movementEntries, online, syncing, confirmedRevision, notice, syncNow, refresh, scope]);

  return <Ctx.Provider value={api_}>{children}</Ctx.Provider>;
}

export function useSync(): SyncApi {
  const c = useContext(Ctx);
  if (!c) throw new Error("useSync must be used inside SyncProvider");
  return c;
}
