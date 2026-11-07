"use client";

import { ChevronDown, Loader2 } from "lucide-react";
import { useCallback, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Alert, Badge } from "@/components/ui/feedback";
import { Input, Label } from "@/components/ui/input";
import type { BreakdownDay, BreakdownHistoryEntry, BreakdownItem } from "@/features/sales/breakdown-types";
import { breakdownErrorKey } from "@/lib/calculations/sales-breakdown";
import { canPressSave, checkClear, checkSave, formUnits, isWholeNumber, previewBreakdown, startingQuantities } from "@/features/sales/breakdown-form";
import { formatBusinessDate } from "@/lib/dates/business";
import { formatShopDateTime } from "@/lib/dates/format";
import { formatLkr } from "@/lib/formatting/money";
import { keyForRequest } from "@/lib/offline/idempotency";
import { useI18n } from "@/providers/i18n-provider";
import { clearBreakdownAction, loadBreakdownDayAction, loadBreakdownHistoryAction, saveBreakdownAction } from "@/server/actions/sales-breakdown";
import type { MessageKey } from "@/i18n";

/**
 * The OPTIONAL "known box sales" panel for a day's inferred sales. Collapsed by default and loaded only when opened, so it never
 * clutters the morning count. It splits the already-inferred sale into whole packages and single units and prices each with the
 * price in force that day; it never changes stock. The same shared rule runs here (live preview) and in the database (authority).
 */
export function SalesBreakdownPanel({ date, timezone, onChanged }: { date: string; timezone?: string; onChanged?: (day: BreakdownDay | null) => void }) {
  const { t, locale } = useI18n();
  const [state, setState] = useState<{ status: "idle" | "loading" | "ready" | "error"; day?: BreakdownDay; canWrite?: boolean; error?: MessageKey }>({ status: "idle" });
  const [open, setOpen] = useState(false);
  // The confirmation lives HERE, not in the item: after a save the day reloads and the item is rebuilt (it is keyed by its revision),
  // which would otherwise wipe the message the moment it appeared.
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async (): Promise<BreakdownDay | null> => {
    setState((s) => ({ ...s, status: "loading" }));
    const r = await loadBreakdownDayAction(date);
    setState(r.ok ? { status: "ready", day: r.day, canWrite: r.canWrite } : { status: "error", error: r.error });
    return r.ok ? r.day : null;
  }, [date]);

  // After a change, tell the page the day as it is NOW (its Estimated Sales total included), so a headline showing that total can follow it.
  // (load first, then call the handler: `onChanged?.(await load())` would skip the load whenever no handler is given)
  const changed = useCallback(async (text: string) => { setNotice(text); const reloaded = await load(); onChanged?.(reloaded); }, [load, onChanged]);
  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next && state.status === "idle") void load();
  };

  return (
    <section aria-labelledby={`sb-h-${date}`} className="text-left">
      <Card className="space-y-4">
        <button type="button" onClick={toggle} aria-expanded={open} className="flex min-h-11 w-full items-center justify-between gap-3 text-left">
          <span>
            <span id={`sb-h-${date}`} className="block text-lg font-semibold">{t("sb.title")}</span>
            <span className="block text-sm text-muted">{t("sb.forDate", { date: formatBusinessDate(date, locale) })}</span>
          </span>
          <ChevronDown className={`size-5 shrink-0 text-muted transition-transform ${open ? "rotate-180" : ""}`} aria-hidden />
        </button>

        {open && (
          <div className="space-y-4">
            <p className="text-sm text-muted">{t("sb.help")}</p>
            {state.status === "loading" && <p className="flex items-center gap-2 text-sm text-muted"><Loader2 className="size-4 animate-spin" aria-hidden />{t("sb.loading")}</p>}
            {state.status === "error" && (
              <div className="space-y-2">
                <Alert tone="danger">{t(state.error ?? "sb.loadFailed")}</Alert>
                <Button variant="secondary" onClick={() => void load()}>{t("common.retry")}</Button>
              </div>
            )}
            {state.status === "ready" && state.day && (
              <>
                {!state.canWrite && <Alert tone="info">{t("sb.viewOnly")}</Alert>}
                {notice && <Alert tone="success" role="status">{notice}</Alert>}
                {state.day.items.length === 0 && <p className="text-sm text-muted">{t("sb.none")}</p>}
                {state.day.items.map((item) => (
                  <ItemEditor key={`${item.variantId}-${item.current?.revision ?? 0}`} item={item} date={date} timezone={timezone} canWrite={!!state.canWrite} onChanged={changed} />
                ))}
                {state.day.unavailable > 0 && <p className="text-sm text-muted">{t("sb.unavailable", { count: state.day.unavailable })}</p>}
              </>
            )}
          </div>
        )}
      </Card>
    </section>
  );
}


function ItemEditor({ item, date, timezone, canWrite, onChanged }: { item: BreakdownItem; date: string; timezone?: string; canWrite: boolean; onChanged: (notice: string) => Promise<void> }) {
  const { t } = useI18n();
  const activeUnits = formUnits(item);
  const [qty, setQty] = useState<Record<string, string>>(() => startingQuantities(item));
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "success" | "danger"; text: string } | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [history, setHistory] = useState<BreakdownHistoryEntry[] | null>(null);
  const keySlot = useRef<{ fingerprint: string; key: string } | null>(null);

  const { entered: anyEntered, result } = previewBreakdown(item, qty);
  const editing = item.current !== null;
  const unknownEstimate = item.plainEstimate;
  const status = item.packagingStatus;

  const save = async () => {
    setMessage(null); setFieldErrors({});
    const check = checkSave(item, date, qty, reason);
    if (!check.ok) { setMessage({ tone: "danger", text: t(check.error) }); return; }
    setBusy(true);
    const draft = check.draft;
    const key = keyForRequest(keySlot, JSON.stringify(draft));
    const r = await saveBreakdownAction(draft, key);
    setBusy(false);
    if (r.ok) { await onChanged(t(r.duplicate ? "sb.duplicate" : "sb.saved")); return; }
    setFieldErrors(r.fieldErrors ?? {});
    setMessage({ tone: "danger", text: t((r.error ?? "auth.error.generic") as MessageKey) });
  };

  const clear = async () => {
    setMessage(null);
    const check = checkClear(reason);
    if (!check.ok) { setMessage({ tone: "danger", text: t(check.error) }); return; }
    setBusy(true);
    const input = { variantId: item.variantId, date, reason: reason.trim() };
    const r = await clearBreakdownAction(input, keyForRequest(keySlot, `clear|${JSON.stringify(input)}`));
    setBusy(false);
    if (r.ok) { await onChanged(t("sb.cleared")); return; }
    setMessage({ tone: "danger", text: t((r.error ?? "auth.error.generic") as MessageKey) });
  };

  const showHistory = async () => {
    if (history) { setHistory(null); return; }
    const r = await loadBreakdownHistoryAction(item.variantId, date);
    setHistory(r.ok ? r.history : []);
  };

  const label = [item.name, item.size].filter(Boolean).join(" ");
  const base = item.base.name;
  const individual = result.ok ? result.remainder : null;

  return (
    <div className="space-y-3 rounded-2xl border border-border p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="font-semibold">{label}</p>
          <p className="num text-sm text-muted">{item.sku} · {t("sb.inferred")}: <span className="font-medium text-foreground">{item.inferred} {base}</span></p>
        </div>
        {status === "known" ? <Badge tone="success">{t("sb.status.known")}</Badge>
          : status === "stale" ? <Badge tone="warning">{t("sb.status.stale")}</Badge>
          : <Badge>{t("sb.status.unknown", { unit: base })}</Badge>}
      </div>

      {status === "stale" && <Alert tone="warning">{t("sb.staleNote", { unit: base })}</Alert>}

      <div className="grid gap-3 sm:grid-cols-2">
        {activeUnits.map((u) => {
          const err = fieldErrors[u.id];
          const q = (qty[u.id] ?? "").trim();
          const eq = q && isWholeNumber(q) ? Number(q) * Number(u.multiplier) : null;
          return (
            <div key={u.id}>
              <Label htmlFor={`sb-${item.variantId}-${u.id}`}>{t("sb.soldIn", { unit: u.name })}</Label>
              <Input
                id={`sb-${item.variantId}-${u.id}`} inputMode="numeric" pattern="[0-9]*" autoComplete="off" disabled={!canWrite || busy}
                value={qty[u.id] ?? ""} placeholder="0" aria-invalid={!!err}
                onChange={(e) => { if (isWholeNumber(e.target.value)) { setQty((s) => ({ ...s, [u.id]: e.target.value })); setMessage(null); setFieldErrors({}); } }}
                className="num"
              />
              <p className="mt-1 text-xs text-muted">
                {u.price === null ? t("sb.noPrice", { unit: u.name }) : `${formatLkr(u.price)} · ${t("sb.soldInHelp", { unit: u.name })}`}
                {eq !== null && eq > 0 && <> · {t("sb.equivalent", { unit: base })}: <span className="num font-medium text-foreground">{eq}</span></>}
              </p>
              {err && <p role="alert" className="mt-1 text-sm text-danger">{t(err as MessageKey)}</p>}
            </div>
          );
        })}
      </div>

      <div className="rounded-xl bg-surface-soft p-3 text-sm" aria-live="polite">
        {anyEntered && result.ok ? (
          <div className="space-y-1">
            {result.lines.map((l) => (
              <p key={l.unitId ?? "base"} className="num">{t("sb.line", { qty: l.quantity, name: l.name, price: formatLkr(l.unitPrice), amount: formatLkr(l.amount) })}</p>
            ))}
            <p className="num">{t("sb.individual", { unit: base })}: <span className="font-semibold">{individual}</span></p>
            <p className="num text-base font-semibold">{t("sb.revenueKnown")}: {formatLkr(result.amount)}</p>
            {unknownEstimate && <p className="text-xs text-muted">{t("sb.compare", { amount: formatLkr(unknownEstimate) })}</p>}
          </div>
        ) : anyEntered && !result.ok ? (
          <p role="alert" className="text-danger">{t(breakdownErrorKey(result.error))}</p>
        ) : (
          <div className="space-y-1">
            <p className="num text-base font-semibold">{t("sb.revenueUnknown")}: {unknownEstimate ? formatLkr(unknownEstimate) : "-"}</p>
            <p className="text-xs text-muted">{t("sb.status.unknown", { unit: base })}</p>
          </div>
        )}
      </div>

      {canWrite && (
        <div className="space-y-3">
          {editing && (
            <div>
              <Label htmlFor={`sb-reason-${item.variantId}`}>{t("sb.reason")}</Label>
              <Input id={`sb-reason-${item.variantId}`} value={reason} maxLength={300} disabled={busy} onChange={(e) => { setReason(e.target.value); setMessage(null); }} />
              <p className="mt-1 text-xs text-muted">{t("sb.reasonHelp")}</p>
            </div>
          )}
          {message && <Alert tone={message.tone}>{message.text}</Alert>}
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => void save()} disabled={busy || !canPressSave(item, qty)}>
              {busy && <Loader2 className="size-4 animate-spin" aria-hidden />}{busy ? t("sb.saving") : editing ? t("sb.update") : t("sb.save")}
            </Button>
            {editing && <Button variant="ghost" onClick={() => void clear()} disabled={busy}>{t("sb.clear")}</Button>}
          </div>
        </div>
      )}
      {!canWrite && message && <Alert tone={message.tone}>{message.text}</Alert>}

      {editing && (
        <div>
          <button type="button" onClick={() => void showHistory()} className="min-h-11 text-sm font-medium text-action underline-offset-4 hover:underline dark:text-sage">{t("sb.history")}</button>
          {history && (
            <ol className="mt-2 space-y-2 text-sm">
              {history.length === 0 && <li className="text-muted">{t("sb.historyNone")}</li>}
              {history.map((h) => (
                <li key={`${h.revision}-${h.action}`} className="rounded-xl border border-border p-3">
                  <p className="font-medium">{t(`sb.action.${h.action}` as MessageKey)}{h.amount ? ` · ${formatLkr(h.amount)}` : ""}</p>
                  <p className="num text-xs text-muted">{formatShopDateTime(h.at, timezone)} · {h.by ? t("sb.historyBy", { name: h.by }) : t("sb.historySystem")}</p>
                  {h.lines.length > 0 && <p className="num mt-1 text-xs">{h.lines.map((l) => `${l.quantity} ${l.name}`).join(" · ")}</p>}
                  {h.reason && <p className="mt-1 text-xs text-muted">{h.reason}</p>}
                </li>
              ))}
            </ol>
          )}
        </div>
      )}
    </div>
  );
}
