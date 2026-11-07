"use client";

import { CheckCircle2, Loader2, Search } from "lucide-react";
import Link from "next/link";
import { useMemo, useRef, useState } from "react";
import { ItemCard } from "@/components/stock/item-card";
import { Button, ButtonLink } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Alert } from "@/components/ui/feedback";
import { Input } from "@/components/ui/input";
import { buildPayloadItems, evaluateItem, type EntryItem, type FieldValues } from "@/features/inventory/count-entry";
import { reviewRecount } from "@/features/inventory/recount-diff";
import { keyForRequest } from "@/lib/offline/idempotency";
import { useI18n } from "@/providers/i18n-provider";
import { submitRecountAction } from "@/server/actions/recount";
import type { MessageKey } from "@/i18n";

const SHOW_STEP = 30;

/**
 * The extra stock sheet: today's counted figures are already filled in; change what was counted again, review what will change, and
 * confirm. Online only (an approval is one-time and only lasts today), and a retry reuses the same key so it can never apply twice.
 */
export function RecountSheet({ requestId, items, initialValues, currentBase, truncated }: {
  requestId: string; items: EntryItem[]; initialValues: Record<string, FieldValues>; currentBase: Record<string, string>; truncated: boolean;
}) {
  const { t } = useI18n();
  const [values, setValues] = useState<Record<string, FieldValues>>(initialValues);
  const [query, setQuery] = useState("");
  const [shown, setShown] = useState(SHOW_STEP);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [itemErrors, setItemErrors] = useState<Record<string, string>>({});
  const [done, setDone] = useState<number | null>(null);
  const keySlot = useRef<{ fingerprint: string; key: string } | null>(null);

  const states = useMemo(() => {
    const m = new Map<string, ReturnType<typeof evaluateItem>>();
    for (const it of items) m.set(it.variantId, evaluateItem(it, values[it.variantId] ?? {}));
    return m;
  }, [items, values]);
  const review = useMemo(() => reviewRecount(items, values, currentBase), [items, values, currentBase]);
  const byId = useMemo(() => new Map(items.map((i) => [i.variantId, i])), [items]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return items.filter((it) => !q || `${it.productName} ${it.productCode} ${it.sku} ${it.sizeLabel}`.toLowerCase().includes(q));
  }, [items, query]);

  const onChange = (variantId: string, key: string, value: string) => {
    setValues((v) => ({ ...v, [variantId]: { ...(v[variantId] ?? {}), [key]: value } }));
    setError(null); setItemErrors({});
  };

  const confirm = async () => {
    setBusy(true); setError(null); setItemErrors({});
    // Only the products whose figure changed are sent: the rest keep today's figure.
    const changed = new Set(review.changes.map((c) => c.variantId));
    const payload = { businessDate: "", revision: null, items: buildPayloadItems(items.filter((i) => changed.has(i.variantId)), values) };
    const key = keyForRequest(keySlot, JSON.stringify(payload));
    try {
      const r = await submitRecountAction(requestId, payload, key);
      if (r.ok) { setDone(r.changed ?? review.changes.length); return; }
      setError(t(r.error));
      if (r.itemErrors) setItemErrors(Object.fromEntries(Object.entries(r.itemErrors).map(([k, v]) => [k, String(v)])));
    } catch {
      setError(t("auth.error.generic" as MessageKey));
    } finally { setBusy(false); }
  };

  if (done !== null) {
    return (
      <div className="mx-auto max-w-xl space-y-5 py-8 text-center">
        <CheckCircle2 className="mx-auto size-14 text-primary" aria-hidden />
        <Alert tone="success">{t("rc.sheet.done", { count: done })}</Alert>
        <div className="flex flex-wrap justify-center gap-3">
          <ButtonLink href="/dashboard" size="lg">{t("nav.dashboard")}</ButtonLink>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <div className="space-y-1">
        <h1 className="text-[28px] font-semibold tracking-tight">{t("rc.sheet.title")}</h1>
        <p className="text-sm text-muted">{t("rc.sheet.help")}</p>
      </div>
      {truncated && <Alert tone="warning">{t("ms.limit", { count: items.length })}</Alert>}
      {error && <Alert tone="danger">{error}</Alert>}

      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted" aria-hidden />
        <Input id="rc-search" type="search" className="pl-10" placeholder={t("rc.sheet.search")} value={query} onChange={(e) => { setQuery(e.target.value); setShown(SHOW_STEP); }} />
      </div>

      <div className="space-y-3">
        {visible.slice(0, shown).map((it) => {
          const st = states.get(it.variantId)!;
          return <ItemCard key={it.variantId} item={it} values={values[it.variantId] ?? {}} state={itemErrors[it.variantId] ? { ...st, kind: "error" } as typeof st : st} disabled={busy} onChange={onChange} />;
        })}
        {visible.length > shown && <Button variant="secondary" onClick={() => setShown((n) => n + SHOW_STEP)}>{t("common.next")} ({visible.length - shown})</Button>}
      </div>

      <Card className="space-y-3">
        <h2 className="text-lg font-semibold">{t("rc.sheet.review")}</h2>
        {review.changes.length === 0 ? <p className="text-sm text-muted">{t("rc.sheet.none")}</p> : (
          <>
            <p className="text-sm">{t("rc.sheet.changes", { count: review.changes.length })}</p>
            <ul className="space-y-1 text-sm">
              {review.changes.map((c) => (
                <li key={c.variantId} className="flex flex-wrap justify-between gap-2">
                  <span>{[byId.get(c.variantId)?.productName, byId.get(c.variantId)?.sizeLabel].filter(Boolean).join(" ")}</span>
                  <span className="num">{c.now} {c.unit}{c.was !== null && <span className="text-muted"> ({t("rc.sheet.was", { old: c.was })})</span>}</span>
                </li>
              ))}
            </ul>
          </>
        )}
        <Button size="lg" disabled={busy || review.changes.length === 0 || review.errors.length > 0} onClick={() => void confirm()}>
          {busy && <Loader2 className="size-4 animate-spin" aria-hidden />}{busy ? t("rc.sheet.confirming") : t("rc.sheet.confirm")}
        </Button>
      </Card>
      <p className="text-center text-sm"><Link href="/morning-stock" className="text-action underline-offset-4 hover:underline dark:text-sage">{t("common.cancel")}</Link></p>
    </div>
  );
}
