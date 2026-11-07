"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Button, ButtonLink } from "@/components/ui/button";
import { Alert, Badge } from "@/components/ui/feedback";
import { formatBusinessDate } from "@/lib/dates/business";
import type { QueuedCount } from "@/lib/offline/sync-queue";
import { useI18n } from "@/providers/i18n-provider";
import { useSync } from "@/providers/sync-provider";
import { variantLabelsAction } from "@/server/actions/inventory";

const num = (q: string) => String(Number(q)); // "70.000" -> "70"

/**
 * Shown when this device's count met a different copy on the server. Nothing has been overwritten: the person sees both
 * sets of numbers and chooses. A day that is already CONFIRMED can only be changed through the correction approval flow,
 * so there the only choices are to drop this device's copy or go and look at the confirmed count.
 */
export function ConflictResolver({ entry, onClose }: { entry: QueuedCount; onClose: () => void }) {
  const { t, locale } = useI18n();
  const { keepMine, discard } = useSync();
  const [busy, setBusy] = useState(false);
  const [names, setNames] = useState<Record<string, string>>({});
  const dialog = useRef<HTMLDivElement>(null);

  const server = entry.conflict?.server ?? null;
  const confirmed = entry.conflict?.reason === "already_confirmed";
  const date = formatBusinessDate(entry.businessDate, locale);

  const rows = useMemo(() => {
    const serverQty = new Map((server?.lines ?? []).map((l) => [l.variantId, l.quantity]));
    const ids = [...new Set([...Object.keys(entry.yours), ...serverQty.keys()])];
    return ids.map((id) => {
      const mine = entry.yours[id];
      const theirs = serverQty.get(id);
      const same = mine !== undefined && theirs !== undefined && Number(mine) === Number(theirs);
      return { id, mine, theirs, same, unit: entry.labels[id]?.unit ?? "" };
    });
  }, [entry, server]);

  // Products the server counted but this device did not: ask for their names.
  const missing = rows.filter((r) => !entry.labels[r.id]).map((r) => r.id);
  useEffect(() => {
    if (missing.length === 0) return;
    let live = true;
    variantLabelsAction(missing).then((m) => { if (live) setNames(m); }).catch(() => undefined);
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `missing` is derived from `rows`
  }, [rows]);
  const nameOf = (id: string) => entry.labels[id]?.name ?? names[id] ?? "…";

  const sorted = [...rows].sort((a, b) => Number(a.same) - Number(b.same) || nameOf(a.id).localeCompare(nameOf(b.id)));
  const differing = rows.filter((r) => !r.same).length;

  // Accessible modal: focus moves in, Escape closes, focus returns to what opened it.
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    dialog.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("keydown", onKey); opener?.focus?.(); };
  }, [onClose]);

  const useMine = async () => { setBusy(true); await keepMine(entry.id); onClose(); };
  const useServer = async () => {
    if (!window.confirm(t("sync.discardConfirm", { date }))) return;
    setBusy(true); await discard(entry.id); onClose();
  };
  const qty = (q: string | undefined, unit: string) => (q === undefined ? <span className="text-muted">{t("sync.conflict.notCounted")}</span> : <span className="num">{num(q)} {unit}</span>);

  return (
    <div className="fixed inset-0 z-[70] flex items-end justify-center bg-black/50 p-0 sm:items-center sm:p-6" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div
        ref={dialog} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="conflict-title"
        className="flex max-h-[92dvh] w-full max-w-2xl flex-col gap-4 overflow-y-auto rounded-t-3xl border border-border bg-surface p-5 shadow-soft outline-none sm:rounded-3xl"
      >
        <div>
          <h2 id="conflict-title" className="text-xl font-semibold">{t("sync.conflict.title")}</h2>
          <p className="num text-muted">{date}</p>
        </div>

        <Alert tone="warning">
          <p>{confirmed ? t("sync.conflict.confirmedIntro", { date }) : server ? t("sync.conflict.draftIntro", { date }) : t("sync.conflict.draftGone", { date })}</p>
          {server?.by && <p className="mt-1">{t("sync.conflict.by", { name: server.by })}</p>}
        </Alert>

        {rows.length > 0 && (
          <div className="overflow-x-auto" tabIndex={0} role="region" aria-label={t("sync.conflict.title")}>
            <table className="w-full text-left text-sm">
              <caption className="sr-only">{t("sync.conflict.differs")}: {differing}</caption>
              <thead>
                <tr className="border-b border-border text-muted">
                  <th scope="col" className="py-2 pr-3 font-medium">{t("sync.conflict.product")}</th>
                  <th scope="col" className="py-2 pr-3 font-medium">{t("sync.conflict.mine")}</th>
                  <th scope="col" className="py-2 pr-3 font-medium">{t("sync.conflict.server")}</th>
                  <th scope="col" className="py-2 font-medium"><span className="sr-only">{t("sync.conflict.differs")}</span></th>
                </tr>
              </thead>
              <tbody>
                {sorted.map((r) => (
                  <tr key={r.id} className="border-b border-border/60">
                    <th scope="row" className="py-2 pr-3 font-medium">{nameOf(r.id)}</th>
                    <td className="py-2 pr-3">{qty(r.mine, r.unit)}</td>
                    <td className="py-2 pr-3">{qty(r.theirs, r.unit)}</td>
                    <td className="py-2">{r.same ? <Badge tone="neutral">{t("sync.conflict.same")}</Badge> : <Badge tone="warning">{t("sync.conflict.differs")}</Badge>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {confirmed && <p className="text-sm text-muted">{t("sync.conflict.askCorrection")}</p>}

        <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
          {!confirmed && <Button size="lg" onClick={useMine} disabled={busy}>{t("sync.conflict.useMine")}</Button>}
          <Button size="lg" variant={confirmed ? "primary" : "secondary"} onClick={useServer} disabled={busy}>{t("sync.conflict.useServer")}</Button>
          {confirmed && server && <ButtonLink size="lg" variant="secondary" href={`/stock-history/${server.sessionId}`}>{t("ms.viewCount")}</ButtonLink>}
          <Button size="lg" variant="ghost" onClick={onClose} disabled={busy}>{t("sync.conflict.close")}</Button>
        </div>
      </div>
    </div>
  );
}
