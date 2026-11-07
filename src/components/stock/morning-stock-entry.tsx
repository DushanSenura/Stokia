"use client";

import { motion } from "motion/react";
import { AlertTriangle, ArrowLeft, Clock, Loader2, Search } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ItemCard } from "@/components/stock/item-card";
import { Button, ButtonLink } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Alert, Badge, EmptyState } from "@/components/ui/feedback";
import { Input, Select } from "@/components/ui/input";
import { buildPayloadItems, evaluateItem, summarize, type EntryItem, type FieldValues, type ItemState } from "@/features/inventory/count-entry";
import { formatBusinessDate } from "@/lib/dates/business";
import { formatLkr } from "@/lib/formatting/money";
import { clearLocalDraft, loadLocalDraft, saveLocalDraft, type LocalDraft } from "@/lib/offline/draft-store";
import { confirmOrQueue } from "@/lib/offline/confirm-flow";
import { keyForRequest } from "@/lib/offline/idempotency";
import { useI18n } from "@/providers/i18n-provider";
import { useSync } from "@/providers/sync-provider";
import { confirmCountAction, discardDraftAction, saveDraftAction, type CountResult } from "@/server/actions/inventory";
import type { SalesSummary } from "@/server/repositories/inventory";
import type { MessageKey } from "@/i18n";
import { cn } from "@/lib/utils/cn";

export interface MorningStockProps {
  shopName: string;
  businessDate: string;
  salesDate: string;
  items: EntryItem[];
  initialValues: Record<string, FieldValues>;
  session: { id: string; revision: number } | null;
  previousDate: string | null;
  /** Calendar days between the previous confirmed count and this one (1 = consecutive mornings). */
  gapDays: number;
  readOnly: boolean;
  truncated: boolean;
  /** `shopId:userId`. When set, entries are also kept on this device until the server has them. */
  draftScope?: string;
}

type Step = "entry" | "review" | "done";
type SaveState = "idle" | "dirty" | "saving" | "saved" | "error" | "conflict";
type Filter = "all" | "notCounted" | "attention";
const SHOW_STEP = 40;
const AUTOSAVE_MS = 1500;
const LOCAL_MS = 300;

export function MorningStockEntry(props: MorningStockProps) {
  const { items, businessDate, salesDate, readOnly } = props;
  const { t, locale } = useI18n();
  const router = useRouter();

  const [values, setValues] = useState(props.initialValues);
  const [step, setStep] = useState<Step>("entry");
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [revision, setRevision] = useState<number | null>(props.session?.revision ?? null);
  const [sessionId, setSessionId] = useState<string | null>(props.session?.id ?? null);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [shown, setShown] = useState(SHOW_STEP);
  const [ack, setAck] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [problem, setProblem] = useState<MessageKey | null>(null);
  const [restored, setRestored] = useState(false);
  const [deviceCopy, setDeviceCopy] = useState<LocalDraft | null>(null);
  const [online, setOnline] = useState(true);
  const [done, setDone] = useState<{ sessionId: string; counted: number; alreadyConfirmed: boolean; sales?: SalesSummary } | null>(null);
  /** The count is saved on this device and waits for the server: NOT confirmed. */
  const [queued, setQueued] = useState(false);
  const sync = useSync();

  // Refs hold the latest data for the async autosave; they are only written from event handlers.
  const valuesRef = useRef(values);
  const revRef = useRef(revision);
  const busy = useRef(false);
  const again = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const scope = props.draftScope;
  const localTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stash = useCallback(() => {
    if (!scope || readOnly) return;
    if (localTimer.current) clearTimeout(localTimer.current);
    localTimer.current = setTimeout(() => {
      void saveLocalDraft({ scope, businessDate, values: valuesRef.current, baseRevision: revRef.current });
    }, LOCAL_MS);
  }, [scope, businessDate, readOnly]);
  const dropLocal = useCallback(() => {
    if (localTimer.current) clearTimeout(localTimer.current);
    if (scope) void clearLocalDraft(scope, businessDate);
  }, [scope, businessDate]);

  const states = useMemo(() => {
    const m = new Map<string, ItemState>();
    for (const it of items) m.set(it.variantId, evaluateItem(it, values[it.variantId] ?? {}));
    return m;
  }, [items, values]);
  const summary = useMemo(() => summarize(items, values), [items, values]);
  const categories = useMemo(() => [...new Set(items.map((i) => i.category).filter((c): c is string => !!c))].sort(), [items]);

  const payload = () => ({ businessDate, revision: revRef.current, items: buildPayloadItems(items, valuesRef.current) });
  const confirmKey = useRef<{ fingerprint: string; key: string } | null>(null);
  const queuedRef = useRef(false);
  const networkFailed = useRef(false);

  /** Persist the current entries. Serialised: a change made mid-save triggers one more pass of the loop. */
  const save = useCallback(async (): Promise<boolean> => {
    if (readOnly) return false;
    // Once this count is queued the queue owns it: a server draft created now would put the queued copy in conflict with itself.
    if (queuedRef.current) return true;
    if (busy.current) { again.current = true; return true; }
    busy.current = true;
    let ok = true;
    networkFailed.current = false;
    try {
      do {
        again.current = false;
        const p = { businessDate, revision: revRef.current, items: buildPayloadItems(items, valuesRef.current) };
        if (p.items.length === 0 && p.revision === null) { setSaveState("idle"); break; } // nothing to save yet
        if (typeof navigator !== "undefined" && navigator.onLine === false) { // offline: the entries are safe on this device
          networkFailed.current = true; ok = false; setSaveState("dirty"); break;
        }
        setSaveState("saving");
        let res: CountResult;
        try { res = await saveDraftAction(p); } catch { res = { ok: false, error: "ms.saveFailed" }; networkFailed.current = true; }
        if (!res.ok) {
          setSaveState(res.conflict ? "conflict" : "error");
          setProblem(res.error);
          ok = false;
          break;
        }
        revRef.current = res.revision;
        setRevision(res.revision);
        setSessionId(res.sessionId);
        setSaveState(again.current ? "saving" : "saved");
        if (!again.current) dropLocal();
      } while (again.current);
    } finally {
      busy.current = false;
    }
    return ok;
  }, [businessDate, items, readOnly, dropLocal]);

  const scheduleSave = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void save(), AUTOSAVE_MS);
  }, [save]);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); if (localTimer.current) clearTimeout(localTimer.current); }, []);

  // Bring back entries that only reached this device (dropped connection, closed tab) before the server saw them.
  useEffect(() => {
    if (!scope || readOnly) return;
    let live = true;
    void loadLocalDraft(scope, businessDate).then((d) => {
      if (!live || !d) return;
      const same = JSON.stringify(d.values) === JSON.stringify(valuesRef.current);
      if (same || Object.keys(d.values).length === 0) { void clearLocalDraft(scope, businessDate); return; }
      if (d.baseRevision === revRef.current) {
        valuesRef.current = d.values;
        setValues(d.values);
        setRestored(true);
        setSaveState("dirty");
        timer.current = setTimeout(() => void save(), AUTOSAVE_MS);
      } else {
        setDeviceCopy(d); // the server moved on since this copy was made: let the person choose
      }
    });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- run once per mounted count
  }, [scope, businessDate, readOnly]);

  // Offline awareness: keep working, and push the entries as soon as the connection returns.
  useEffect(() => {
    const sync = () => setOnline(navigator.onLine);
    const back = () => { setOnline(true); if (!busy.current) void save(); };
    sync();
    window.addEventListener("offline", sync);
    window.addEventListener("online", back);
    return () => { window.removeEventListener("offline", sync); window.removeEventListener("online", back); };
  }, [save]);

  const onChange = useCallback((variantId: string, key: string, value: string) => {
    const next = { ...valuesRef.current, [variantId]: { ...(valuesRef.current[variantId] ?? {}), [key]: value } };
    valuesRef.current = next;
    setValues(next);
    setSaveState((s) => (s === "conflict" ? s : "dirty"));
    setProblem(null);
    setRestored(false);
    stash();
    scheduleSave();
  }, [scheduleSave, stash]);

  // Warn before leaving with unsaved entries.
  useEffect(() => {
    if (saveState !== "dirty" && saveState !== "saving") return;
    const h = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener("beforeunload", h);
    return () => window.removeEventListener("beforeunload", h);
  }, [saveState]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return items.filter((it) => {
      if (category && it.category !== category) return false;
      if (q && !`${it.productName} ${it.productCode} ${it.sku} ${it.sizeLabel}`.toLowerCase().includes(q)) return false;
      const st = states.get(it.variantId)!;
      if (filter === "notCounted") return st.kind === "not_counted";
      if (filter === "attention") return st.kind === "error" || (st.kind === "counted" && st.flag === "increase");
      return true;
    });
  }, [items, query, category, filter, states]);

  const flush = async () => {
    if (timer.current) clearTimeout(timer.current);
    while (busy.current) await new Promise((r) => setTimeout(r, 50)); // let an in-flight autosave finish first
    return save();
  };

  const goReview = async () => {
    // A refusal from the server stops here. A missing connection does not: the entries are safe on this device,
    // and confirming will queue them to be sent (and only confirmed) once the server answers.
    if (!(await flush()) && !networkFailed.current) return;
    setAck(false); setProblem(null); setStep("review");
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const confirm = async () => {
    setConfirming(true); setProblem(null);
    if (timer.current) clearTimeout(timer.current);
    // Wait for any in-flight autosave so the revision we confirm is current.
    while (busy.current) await new Promise((r) => setTimeout(r, 50));
    const p = payload();
    // One key per distinct request: a retry after a lost response (or a double tap) reuses it and cannot apply twice.
    const key = keyForRequest(confirmKey, JSON.stringify([p, ack]));

    // What the conflict screen needs later: product names, and the base quantities this device recorded.
    const queueInput = () => {
      const labels: Record<string, { name: string; unit: string }> = {};
      const yours: Record<string, string> = {};
      for (const line of p.items) {
        const item = items.find((i) => i.variantId === line.variantId);
        if (!item) continue;
        labels[item.variantId] = { name: [item.productName, item.sizeLabel].filter(Boolean).join(" "), unit: item.baseUnit };
        const s = states.get(item.variantId);
        if (s?.kind === "counted") yours[item.variantId] = s.baseQuantity;
      }
      return { scope: scope ?? "", businessDate, payload: p, ack, key, labels, yours };
    };

    // The decision (confirm / keep on the device / keep as a conflict) is shared with the phone app: see confirm-flow.ts.
    const outcome = await confirmOrQueue({
      online: typeof navigator === "undefined" || navigator.onLine !== false,
      canQueue: !!scope,
      submit: () => confirmCountAction(p, ack, key),
      queueInput, enqueue: sync.enqueue, recordConflict: sync.recordConflict,
    });
    setConfirming(false);

    switch (outcome.kind) {
      case "queued":
        queuedRef.current = true; if (timer.current) clearTimeout(timer.current); dropLocal(); setQueued(true); setStep("done");
        break;
      case "queue_failed":
        setProblem(outcome.reason === "exists" ? "sync.exists" : "sync.cannotQueue");
        break;
      case "confirmed": {
        const res = outcome.result;
        dropLocal();
        setDone({ sessionId: res.sessionId, counted: res.counted, alreadyConfirmed: !!res.alreadyConfirmed, sales: res.sales });
        setStep("done");
        break;
      }
      case "conflict":
        setProblem(outcome.result.error); setSaveState("conflict");
        break;
      case "rejected":
        setProblem(outcome.result.error);
        break;
    }
  };

  const discard = async () => {
    if (!sessionId || revision === null || !window.confirm(t("ms.discardConfirm"))) return;
    const r = await discardDraftAction(sessionId, revision);
    if (r.ok) { dropLocal(); valuesRef.current = {}; setValues({}); setSessionId(null); setRevision(null); revRef.current = null; setSaveState("idle"); router.refresh(); }
    else if (r.error) setProblem(r.error);
  };

  const dateLabel = formatBusinessDate(businessDate, locale);
  const salesLabel = formatBusinessDate(salesDate, locale);
  const isFirst = props.previousDate === null;
  const pct = summary.total ? Math.round((summary.counted / summary.total) * 100) : 0;
  const missingList = items.filter((it) => states.get(it.variantId)!.kind === "not_counted");
  const errorList = items.filter((it) => states.get(it.variantId)!.kind === "error");
  const reviewList = items.filter((it) => { const s = states.get(it.variantId)!; return s.kind === "counted" && s.flag === "increase"; });

  const statusBadge = revision === null && summary.counted === 0 ? { tone: "neutral" as const, key: "ms.status.notStarted" as const }
    : summary.needsReview > 0 ? { tone: "warning" as const, key: "ms.status.needsReview" as const }
    : { tone: "info" as const, key: "ms.status.draft" as const };

  /* ---------------- saved on this device, waiting for the server ---------------- */
  if (step === "done" && queued) {
    // Once the server has answered with a conflict or a refusal, the notice above the page says so: do not keep promising "will be sent".
    const waiting = sync.entries.find((e) => e.businessDate === businessDate);
    const stillPending = !waiting || waiting.state === "pending";
    return (
      <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.25 }} className="mx-auto max-w-xl py-10 text-center">
        <Clock className="mx-auto size-16 text-info" aria-hidden />
        <h1 className="mt-6 text-[28px] font-semibold tracking-tight">{t("sync.queuedTitle")}</h1>
        {stillPending && (
          <>
            <p className="mt-2 text-muted">{t("sync.queuedBody", { date: dateLabel })}</p>
            <Alert tone="info" className="mt-5 text-left">{t("sync.queuedHint")}</Alert>
          </>
        )}
        <div className="mt-8 flex flex-wrap justify-center gap-3">
          <ButtonLink href="/dashboard" size="lg">{t("nav.dashboard")}</ButtonLink>
        </div>
      </motion.div>
    );
  }

  /* ---------------- success ---------------- */
  if (step === "done" && done) {
    return (
      <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.25 }} className="mx-auto max-w-xl py-10 text-center">
        <svg viewBox="0 0 52 52" className="mx-auto size-20" aria-hidden>
          <circle cx="26" cy="26" r="24" fill="var(--mint)" />
          <path className="check-draw" d="M15 27l8 8 14-16" fill="none" stroke="var(--action)" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <h1 className="mt-6 text-[28px] font-semibold tracking-tight">{t("ms.successTitle")}</h1>
        <p className="mt-2 text-muted">{t("ms.successBody", { date: dateLabel })}</p>
        {isFirst ? (
          <p className="mt-1 text-muted">{t("ms.successFirst")}</p>
        ) : done.sales && done.sales.calculated > 0 ? (
          <div className="mt-4 space-y-1">
            <p className="text-lg font-medium">{t("ms.successSales")}</p>
            <p className="text-sm text-muted">{t("ms.successTotal", { date: salesLabel })}</p>
            <p className="num text-4xl font-semibold text-action dark:text-primary">{formatLkr(done.sales.estimatedTotal)}</p>
            {Object.keys(done.sales.unitsByBaseUnit).length > 0 && (
              <p className="num text-sm text-muted">{Object.entries(done.sales.unitsByBaseUnit).map(([u, n]) => `${n} ${u}`).join(" · ")}</p>
            )}
            {done.sales.needsReview > 0 && <p className="text-sm text-warning">{t("ms.successReview", { count: done.sales.needsReview })}</p>}
            {done.sales.pending > 0 && <p className="text-sm text-muted">{t("ms.successPending", { count: done.sales.pending })}</p>}
          </div>
        ) : props.gapDays > 1 ? (
          <p className="mt-2 text-muted">{t("ms.successGap")}</p>
        ) : done.sales && done.sales.needsReview > 0 ? (
          <p className="mt-2 text-warning">{t("ms.successReview", { count: done.sales.needsReview })}</p>
        ) : null}
        {!isFirst && <p className="mx-auto mt-3 max-w-md text-sm text-muted">{t("sales.estimateNote")}</p>}
        <div className="mt-8 flex flex-wrap justify-center gap-3">
          <ButtonLink href="/dashboard" size="lg">{t("nav.dashboard")}</ButtonLink>
          <ButtonLink href={`/stock-history/${done.sessionId}`} variant="secondary" size="lg">{t("ms.viewCount")}</ButtonLink>
        </div>
      </motion.div>
    );
  }

  /* ---------------- header (shared) ---------------- */
  const header = (
    <header className="space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-[26px] font-semibold tracking-tight sm:text-[30px]">{t("ms.title")}</h1>
          <p className="num text-lg font-medium">{t("ms.countDate", { date: dateLabel })}</p>
          <p className="num text-muted">{t("ms.calculatesFor", { date: salesLabel })}</p>
          <p className="text-sm text-muted">{props.shopName}</p>
        </div>
        <Badge tone={statusBadge.tone}>{t(statusBadge.key)}</Badge>
      </div>
      <div>
        <div className="mb-1 flex items-center justify-between text-sm">
          <span className="num font-medium">{t("ms.progress", { counted: summary.counted, total: summary.total })}</span>
          <span className="num text-muted">{pct}%</span>
        </div>
        <div role="progressbar" aria-valuemin={0} aria-valuemax={summary.total} aria-valuenow={summary.counted} aria-label={t("ms.progress", { counted: summary.counted, total: summary.total })} className="h-2.5 overflow-hidden rounded-full bg-surface-soft">
          <motion.div className="h-full rounded-full bg-primary" initial={false} animate={{ width: `${pct}%` }} transition={{ duration: 0.2 }} />
        </div>
      </div>
    </header>
  );

  /* ---------------- review ---------------- */
  if (step === "review") {
    const canConfirm = summary.errors === 0 && summary.counted > 0 && (missingList.length === 0 || ack);
    return (
      <div className="mx-auto max-w-3xl space-y-6">
        {header}
        <Card className="space-y-5">
          <h2 className="text-xl font-semibold">{t("ms.reviewTitle")}</h2>
          <dl className="grid grid-cols-3 gap-3 text-center">
            <div className="rounded-2xl bg-surface-soft p-3"><dt className="text-xs text-muted">{t("ms.reviewCounted")}</dt><dd className="num text-2xl font-semibold">{summary.counted}</dd></div>
            <div className="rounded-2xl bg-surface-soft p-3"><dt className="text-xs text-muted">{t("ms.reviewNotCounted")}</dt><dd className="num text-2xl font-semibold">{summary.notCounted}</dd></div>
            <div className={cn("rounded-2xl p-3", summary.needsReview ? "bg-warning-soft text-warning" : "bg-surface-soft")}><dt className="text-xs">{t("ms.reviewNeedsReview")}</dt><dd className="num text-2xl font-semibold">{summary.needsReview}</dd></div>
          </dl>

          {!isFirst && (
            <div className="rounded-2xl bg-surface-soft p-4">
              <p className="text-sm text-muted">{t("ms.reviewEstSales")} · {salesLabel}</p>
              <p className="num text-3xl font-semibold">{formatLkr(summary.estimatedTotal)}</p>
              {Object.keys(summary.unitsByBaseUnit).length > 0 && (
                <p className="num mt-1 text-sm text-muted">{t("ms.reviewUnitsSold")}: {Object.entries(summary.unitsByBaseUnit).map(([u, n]) => `${n} ${u}`).join(" · ")}</p>
              )}
              <p className="mt-2 text-xs text-muted">{t("ms.previewNote")}</p>
            </div>
          )}

          {errorList.length > 0 && (
            <Alert tone="danger">
              <p className="font-medium">{t("ms.fixErrors")}</p>
              <ul className="mt-1 list-disc pl-5">{errorList.map((i) => <li key={i.variantId}>{i.productName} {i.sizeLabel}</li>)}</ul>
            </Alert>
          )}
          {reviewList.length > 0 && (
            <Alert tone="warning">
              <p className="font-medium">{t("ms.flag.increase")}</p>
              <ul className="mt-1 list-disc pl-5">{reviewList.map((i) => <li key={i.variantId}>{i.productName} {i.sizeLabel}</li>)}</ul>
            </Alert>
          )}
          {missingList.length > 0 && (
            <details className="rounded-xl border border-border p-4" open={missingList.length <= 8}>
              <summary className="flex min-h-11 cursor-pointer items-center font-medium">{t("ms.reviewMissingList")} ({missingList.length})</summary>
              <ul className="mt-2 list-disc space-y-0.5 pl-5 text-sm">{missingList.map((i) => <li key={i.variantId}>{i.productName} {i.sizeLabel}</li>)}</ul>
            </details>
          )}
          {missingList.length > 0 && (
            <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-border p-4">
              <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} className="mt-1 size-5 accent-[var(--action)]" />
              <span>{t("ms.ackMissing", { count: missingList.length })}</span>
            </label>
          )}
          {problem && <Alert tone="danger">{t(problem)}</Alert>}
        </Card>

        <div className="sticky bottom-14 z-30 flex flex-col gap-2 rounded-2xl border border-border bg-surface/95 p-3 shadow-soft backdrop-blur sm:flex-row sm:justify-between md:bottom-3">
          <Button variant="secondary" size="lg" onClick={() => setStep("entry")} disabled={confirming}><ArrowLeft className="size-4" aria-hidden />{t("ms.back")}</Button>
          <Button size="lg" onClick={confirm} disabled={!canConfirm || confirming} aria-busy={confirming}>
            {confirming && <Loader2 className="size-4 animate-spin" aria-hidden />}
            {confirming ? t("ms.confirming") : t("ms.confirm")}
          </Button>
        </div>
      </div>
    );
  }

  /* ---------------- entry ---------------- */
  const saveText = saveState === "saving" ? t("ms.saving") : saveState === "saved" ? t("ms.savedAt") : saveState === "dirty" ? t("ms.unsaved") : saveState === "error" ? t("ms.saveFailed") : "";

  return (
    <div className="mx-auto max-w-4xl space-y-5">
      {header}

      <div className="space-y-2">
        {isFirst && <Alert tone="info">{t("ms.firstCount")}</Alert>}
        {!isFirst && props.gapDays > 1 && props.previousDate && <Alert tone="warning">{t("ms.gap", { date: formatBusinessDate(props.previousDate, locale), days: props.gapDays })}</Alert>}
        {readOnly && <Alert tone="info">{t("ms.readOnly")}</Alert>}
        {!online && <Alert tone="warning">{t("ms.offline")}</Alert>}
        {restored && <Alert tone="info">{t("ms.local.restored")}</Alert>}
        {deviceCopy && (
          <Alert tone="warning">
            <p className="font-medium">{t("ms.local.differsTitle")}</p>
            <p>{t("ms.local.differsBody", { count: Object.keys(deviceCopy.values).length })}</p>
            <div className="mt-2 flex flex-wrap gap-2">
              <Button variant="secondary" onClick={() => {
                valuesRef.current = deviceCopy.values; setValues(deviceCopy.values); setDeviceCopy(null); setSaveState("dirty"); stash(); scheduleSave();
              }}>{t("ms.local.use")}</Button>
              <Button variant="ghost" onClick={() => { setDeviceCopy(null); dropLocal(); }}>{t("ms.local.discard")}</Button>
            </div>
          </Alert>
        )}
        {saveState === "conflict" && (
          <Alert tone="danger">
            <p>{t(problem === "ms.conflictConfirmed" ? "ms.conflictConfirmed" : "ms.conflict")}</p>
            <Button className="mt-2" variant="secondary" onClick={() => router.refresh()}>{t("ms.reload")}</Button>
          </Alert>
        )}
        {problem && saveState !== "conflict" && <Alert tone="danger">{t(problem)}</Alert>}
        {props.truncated && <Alert tone="warning">{t("ms.limit", { count: items.length })}</Alert>}
      </div>

      <div className="grid gap-3 sm:grid-cols-[1fr_auto_auto]">
        <div className="relative">
          <Search className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-muted" aria-hidden />
          <label htmlFor="ms-search" className="sr-only">{t("ms.search")}</label>
          <Input id="ms-search" type="search" className="pl-10" placeholder={t("ms.search")} value={query} onChange={(e) => { setQuery(e.target.value); setShown(SHOW_STEP); }} />
        </div>
        {categories.length > 0 && (
          <div>
            <label htmlFor="ms-cat" className="sr-only">{t("cat.products.category")}</label>
            <Select id="ms-cat" value={category} onChange={(e) => { setCategory(e.target.value); setShown(SHOW_STEP); }}>
              <option value="">{t("ms.allCategories")}</option>
              {categories.map((c) => <option key={c} value={c}>{c}</option>)}
            </Select>
          </div>
        )}
        <div role="group" aria-label="Filter" className="flex gap-1 rounded-xl bg-surface-soft p-1">
          {(["all", "notCounted", "attention"] as Filter[]).map((f) => (
            <button key={f} type="button" aria-pressed={filter === f} onClick={() => { setFilter(f); setShown(SHOW_STEP); }}
              className={cn("min-h-11 flex-1 rounded-lg px-3 text-sm font-medium transition-colors duration-150", filter === f ? "bg-surface shadow-soft" : "text-muted hover:text-foreground")}>
              {t(`ms.filter.${f}` as MessageKey)}
            </button>
          ))}
        </div>
      </div>

      {items.length === 0 ? (
        <EmptyState title={t("ms.noItems")} action={<ButtonLink href="/products/new">{t("cat.products.new")}</ButtonLink>} />
      ) : visible.length === 0 ? (
        <EmptyState title={t("ms.noMatch")} />
      ) : (
        <div className="grid gap-3">
          {visible.slice(0, shown).map((it) => (
            <ItemCard key={it.variantId} item={it} values={values[it.variantId] ?? {}} state={states.get(it.variantId)!} disabled={readOnly || confirming} onChange={onChange} />
          ))}
        </div>
      )}
      {visible.length > shown && (
        <div className="text-center"><Button variant="secondary" onClick={() => setShown((s) => s + SHOW_STEP)}>{t("common.next")} ({visible.length - shown})</Button></div>
      )}

      {!readOnly && (
        <div className="sticky bottom-14 z-30 flex flex-col gap-2 rounded-2xl border border-border bg-surface/95 p-3 shadow-soft backdrop-blur sm:flex-row sm:items-center sm:justify-between md:bottom-3">
          <div className="flex items-center justify-between gap-3 sm:justify-start">
            <span className="num text-sm font-medium">{t("ms.progress", { counted: summary.counted, total: summary.total })}</span>
            <span aria-live="polite" className={cn("text-sm", saveState === "error" ? "text-danger" : "text-muted")}>{saveText}</span>
          </div>
          <div className="flex gap-2">
            {sessionId && <Button variant="ghost" onClick={discard}>{t("ms.discard")}</Button>}
            <Button variant="secondary" className="flex-1 sm:flex-none" onClick={() => void flush()} disabled={saveState === "saving"}>{t("ms.saveDraft")}</Button>
            <Button className="flex-1 sm:flex-none" onClick={goReview} disabled={summary.counted === 0 || saveState === "conflict"}>{t("ms.review")}</Button>
          </div>
        </div>
      )}
      {summary.errors > 0 && <p className="flex items-center gap-2 text-sm text-danger"><AlertTriangle className="size-4" aria-hidden />{t("ms.fixErrors")}</p>}
      <p className="text-center text-xs text-muted"><Link href="/stock-history" className="underline-offset-4 hover:underline">{t("nav.history")}</Link></p>
    </div>
  );
}
