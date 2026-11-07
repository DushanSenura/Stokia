import { useCallback, useEffect, useRef, useState } from "react";
import type { FieldValues } from "@/features/inventory/count-entry";
import { ApiForbidden, ApiSignedOut, type MorningStockResponse } from "~/lib/api-client";
import { api } from "~/lib/api";
import { kvGetJson, kvRemove, kvSetJson } from "~/lib/kv";
import { draftKey, useSync } from "~/providers/sync";
import { useSession } from "~/providers/session";
import { offlineView } from "./offline-view";

const DRAFT_MS = 300;
interface SavedDraft { values: Record<string, FieldValues>; baseRevision: number | null; savedAt: number }

/**
 * Loads the morning-stock screen's data (from the server, or from the copy saved on the phone when there is no connection) and keeps
 * the person's unfinished entries on the phone as they type, so a closed app, a dead battery or a dropped connection loses nothing.
 */
export function useMorningStock(requestedDate?: string) {
  const { shop, user, signOut } = useSession();
  const { confirmedRevision } = useSync();
  const shopId = shop!.shopId;
  const scope = `${shopId}:${user!.id}`;
  const cacheKey = `cache.stock.${shopId}`;

  const [data, setData] = useState<MorningStockResponse | null>(null);
  const [source, setSource] = useState<"server" | "phone">("server");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<"unreachable" | "forbidden" | null>(null);
  const [values, setValuesState] = useState<Record<string, FieldValues>>({});
  const [restored, setRestored] = useState(false);
  const valuesRef = useRef(values);
  const dateRef = useRef<string | null>(null);
  const frozen = useRef(false); // set once the count is queued or confirmed: the queue (or the server) owns it now
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const apply = useCallback(async (d: MorningStockResponse, from: "server" | "phone") => {
    const draft = await kvGetJson<SavedDraft>(draftKey(scope, d.businessDate));
    // The phone's own unfinished entries win, product by product, over the server's draft for the same morning.
    const merged = { ...d.initialValues, ...(draft?.values ?? {}) };
    valuesRef.current = merged;
    dateRef.current = d.businessDate;
    frozen.current = false;
    setValuesState(merged);
    setRestored(!!draft && Object.keys(draft.values).length > 0);
    setData(d);
    setSource(from);
  }, [scope]);

  const load = useCallback(async () => {
    try {
      const d = await api.morningStock(shopId, requestedDate);
      if (d.items.length > 0) await kvSetJson(cacheKey, d); // keep the products for counting offline
      await apply(d, "server");
      setError(null);
    } catch (e) {
      if (e instanceof ApiSignedOut) { await signOut(); return; }
      const cached = await kvGetJson<MorningStockResponse>(cacheKey);
      if (cached && !(e instanceof ApiForbidden)) await apply(offlineView(cached, shop!, requestedDate), "phone");
      else setError(e instanceof ApiForbidden ? "forbidden" : "unreachable");
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- shop is stable for a given shopId
  }, [shopId, requestedDate, cacheKey, apply, signOut]);

  // Load on open, and again whenever a queued count was confirmed or discarded.
  useEffect(() => {
    let live = true;
    void (async () => { if (live) await load(); })();
    return () => { live = false; };
  }, [load, confirmedRevision]);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const setValue = useCallback((variantId: string, key: string, value: string) => {
    if (frozen.current) return;
    const next = { ...valuesRef.current, [variantId]: { ...(valuesRef.current[variantId] ?? {}), [key]: value } };
    valuesRef.current = next;
    setValuesState(next);
    setRestored(false);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      const date = dateRef.current;
      if (date && !frozen.current) void kvSetJson(draftKey(scope, date), { values: valuesRef.current, baseRevision: null, savedAt: Date.now() } satisfies SavedDraft);
    }, DRAFT_MS);
  }, [scope]);

  /** The count is now owned by the queue or the server: stop saving, and remove the on-phone draft. */
  const release = useCallback(() => {
    frozen.current = true;
    if (timer.current) clearTimeout(timer.current);
    if (dateRef.current) void kvRemove(draftKey(scope, dateRef.current));
  }, [scope]);

  /** Retry from a button: show the spinner again, then load. */
  const reload = useCallback(() => { setLoading(true); setError(null); return load(); }, [load]);

  return { data, source, loading, error, values, valuesRef, restored, setValue, release, reload, scope };
}
