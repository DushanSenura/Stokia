import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Alert, Badge } from "@/components/ui/feedback";
import { ButtonLink } from "@/components/ui/button";
import { getTranslator } from "@/i18n/server";
import { formatBusinessDate, salesDateFor } from "@/lib/dates/business";
import { formatShopDateTime } from "@/lib/dates/format";
import { createClient } from "@/lib/supabase/server";
import { SalesTable } from "@/components/stock/sales-table";
import { formatLkr } from "@/lib/formatting/money";
import { getSalesForDate, getSessionDetail, summarizeSales } from "@/server/repositories/inventory";
import { getSessionContext } from "@/server/services/session";
import { CorrectionForm } from "@/components/settings/correction-controls";
import { can } from "@/server/permissions";
import { getUnitsByVariant, listCorrections } from "@/server/repositories/settings";
import type { MessageKey } from "@/i18n";
import Decimal from "decimal.js";

export const metadata: Metadata = { title: "Count details" };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const tone = { draft: "info", needs_review: "warning", confirmed: "success", corrected: "neutral" } as const;
const statusKey = { draft: "ms.status.draft", needs_review: "ms.status.needsReview", confirmed: "ms.status.confirmed", corrected: "ms.status.corrected" } as const;

export default async function CountDetailPage({ params }: PageProps<"/stock-history/[sessionId]">) {
  const { sessionId } = await params;
  if (!UUID.test(sessionId)) notFound();
  const { t, locale } = await getTranslator();
  const m = (await getSessionContext()).membership!;
  const supabase = await createClient();
  const d = await getSessionDetail(supabase, sessionId);
  if (!d) notFound();
  const { session, lines, prev, prevQty, info, people } = d;

  // The sales this morning's count calculated belong to the PREVIOUS day.
  const salesDate = salesDateFor(session.business_date);
  const salesRows = session.status === "draft" ? [] : await getSalesForDate(supabase, session.shop_id, salesDate);
  const salesSummary = summarizeSales(salesDate, salesRows);

  // Historical corrections: a confirmed count is never edited in place. A correction is requested (stock manager) or applied (owner),
  // keeps the old value, and recalculates the days it touches.
  const canRequest = can(m.role, "corrections.request") && session.status !== "draft";
  const isOwner = can(m.role, "corrections.decide");
  const corrections = session.status === "draft" ? [] : await listCorrections(supabase, { sessionId: session.id });
  const pendingBy = new Set(corrections.filter((c) => c.status === "pending").map((c) => c.variantId));
  const unitsBy = canRequest ? await getUnitsByVariant(supabase, lines.map((l) => l.variant_id)) : new Map();

  const rows = lines
    .map((l) => ({ l, v: info.get(l.variant_id) }))
    .sort((a, b) => (a.v?.name ?? "").localeCompare(b.v?.name ?? "") || (a.v?.sku ?? "").localeCompare(b.v?.sku ?? ""));

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-[28px] font-semibold tracking-tight">{t("ms.countDate", { date: formatBusinessDate(session.business_date, locale) })}</h1>
          <p className="num text-muted">{t("ms.calculatesFor", { date: formatBusinessDate(salesDateFor(session.business_date), locale) })}</p>
          <p className="mt-1 text-sm text-muted">
            {people.get(session.confirmed_by ?? "") ?? people.get(session.created_by) ?? ""}
            {session.confirmed_at ? ` · ${formatShopDateTime(session.confirmed_at, m.timezone)}` : ""}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Badge tone={tone[session.status]}>{t(statusKey[session.status])}</Badge>
          <ButtonLink href="/stock-history" variant="ghost">{t("sh.detail.back")}</ButtonLink>
        </div>
      </div>

      {session.status === "draft" && <Alert tone="info">{t("sh.detail.draftNote")}</Alert>}
      {!prev && session.status !== "draft" && <Alert tone="info">{t("sh.detail.firstCount")}</Alert>}

      <div tabIndex={0} className="overflow-x-auto rounded-[var(--radius-card)] border border-border bg-surface shadow-soft">
        <table className="w-full min-w-[40rem] text-left text-sm">
          <thead className="border-b border-border text-muted">
            <tr>
              {(["sh.detail.product", "sh.detail.entered", "sh.detail.quantity", "sh.detail.previous", "sh.detail.change"] as const).map((k) => <th key={k} scope="col" className="px-4 py-3 font-medium">{t(k)}</th>)}
              {canRequest && <th scope="col" className="px-4 py-3"><span className="sr-only">{t("common.actions")}</span></th>}
            </tr>
          </thead>
          <tbody className="num">
            {rows.map(({ l, v }) => {
              const counted = l.count_status === "counted";
              const previous = prevQty.get(l.variant_id);
              const change = counted && previous !== undefined ? new Decimal(l.normalized_base_quantity!).minus(previous) : null;
              const entered = (l.entry_details?.entries ?? []).map((e) => `${e.quantity} ${(e as { unit_name?: string }).unit_name ?? ""}`.trim()).join(" + ");
              return (
                <tr key={l.variant_id} className="border-t border-border">
                  <td className="px-4 py-3"><span className="font-medium">{v?.name}</span> <span className="text-muted">{v?.size} · {v?.sku}</span></td>
                  <td className="px-4 py-3 text-muted">{counted ? entered || "—" : ""}</td>
                  <td className="px-4 py-3 font-medium">
                    {counted ? `${new Decimal(l.normalized_base_quantity!).toString()} ${v?.unit ?? ""}` : <Badge tone="warning">{t("sh.detail.notCounted")}</Badge>}
                    {(() => {
                      const d = l.entry_details as { corrected?: boolean; previous?: { quantity: number | null } } | null;
                      return d?.corrected ? <Badge tone="info" className="ml-2 font-normal">{t("cor.corrected", { old: d.previous?.quantity === null || d.previous?.quantity === undefined ? t("cor.notCounted") : String(d.previous.quantity) })}</Badge> : null;
                    })()}
                    {pendingBy.has(l.variant_id) && <Badge tone="warning" className="ml-2 font-normal">{t("cor.pendingBadge")}</Badge>}
                  </td>
                  <td className="px-4 py-3">{previous !== undefined ? new Decimal(previous).toString() : "—"}</td>
                  <td className="px-4 py-3">{change ? `${change.gt(0) ? "+" : ""}${change.toString()}` : "—"}</td>
                  {canRequest && (
                    <td className="px-4 py-3 font-sans">
                      {pendingBy.has(l.variant_id) ? null : (
                        <details className="w-72 max-w-[80vw]">
                          <summary className="flex min-h-11 cursor-pointer items-center text-sm text-action underline-offset-4 hover:underline dark:text-sage">{isOwner ? t("cor.correct") : t("cor.request")}</summary>
                          <div className="mt-2">
                            <CorrectionForm sessionId={session.id} variantId={l.variant_id} units={unitsBy.get(l.variant_id) ?? []} baseUnit={v?.unit ?? ""} isOwner={isOwner} idPrefix={`cor-${l.variant_id.slice(0, 8)}`} />
                          </div>
                        </details>
                      )}
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {corrections.length > 0 && (
        <section aria-labelledby="cor-h" className="space-y-3">
          <h2 id="cor-h" className="text-xl font-semibold">{t("cor.title")}</h2>
          <ul className="space-y-2">
            {corrections.map((c) => (
              <li key={c.id} className="rounded-2xl border border-border bg-surface p-4 text-sm">
                <p className="flex flex-wrap items-center gap-2"><span className="font-medium">{c.product} {c.size}</span><span className="num">{t("cor.oldNew", { old: c.oldQuantity ?? t("cor.notCounted"), new: c.newQuantity, unit: c.unit })}</span><Badge tone={c.status === "approved" ? "success" : c.status === "pending" ? "warning" : c.status === "rejected" ? "danger" : "neutral"}>{t(`cor.status.${c.status}` as MessageKey)}</Badge></p>
                <p className="text-muted">“{c.reason}” · {t("cor.by", { name: c.requester, date: formatShopDateTime(c.createdAt, m.timezone) })}</p>
                {c.decidedAt && <p className="text-xs text-muted">{t("cor.decidedBy", { status: t(`cor.status.${c.status}` as MessageKey), name: c.decider ?? "", date: formatShopDateTime(c.decidedAt, m.timezone) })}{c.decisionNote ? ` · “${c.decisionNote}”` : ""}</p>}
              </li>
            ))}
          </ul>
        </section>
      )}

      {session.status !== "draft" && (
        <section aria-labelledby="sales-h" className="space-y-3">
          <div>
            <h2 id="sales-h" className="text-xl font-semibold">{t("sales.title")}</h2>
            <p className="text-sm text-muted">{t("sales.subtitle", { date: formatBusinessDate(salesDate, locale) })}</p>
          </div>
          {salesSummary.calculated > 0 && (
            <p className="num text-lg">
              {t("sales.col.value")}: <span className="font-semibold">{formatLkr(salesSummary.estimatedTotal)}</span>
              <span className="ml-3 text-sm text-muted">{Object.entries(salesSummary.unitsByBaseUnit).map(([u, n]) => `${n} ${u}`).join(" · ")}</span>
            </p>
          )}
          <SalesTable rows={salesRows} t={t} />
          <p className="text-xs text-muted">{t("sales.estimateNote")}</p>
        </section>
      )}
    </div>
  );
}
