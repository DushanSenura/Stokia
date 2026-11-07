import type { Metadata } from "next";
import Link from "next/link";
import { FileText } from "lucide-react";
import { Badge, EmptyState } from "@/components/ui/feedback";
import { getTranslator } from "@/i18n/server";
import { formatBusinessDate, formatMonth } from "@/lib/dates/business";
import { formatShopDateTime } from "@/lib/dates/format";
import { formatLkr } from "@/lib/formatting/money";
import { createClient } from "@/lib/supabase/server";
import { listedMonths } from "@/features/reports/report";
import { loadReportIndex } from "@/server/repositories/reports";
import { getSessionContext } from "@/server/services/session";
import type { MessageKey } from "@/i18n";

export const metadata: Metadata = { title: "Monthly Reports" };

export default async function ReportsPage() {
  const { t, locale } = await getTranslator();
  const m = (await getSessionContext()).membership!;
  let rows;
  try { rows = await loadReportIndex(await createClient(), { shopId: m.shopId, shopName: m.shopName, timezone: m.timezone }); }
  catch { return <EmptyState title={t("error.title")} body={t("rep.error")} />; }
  const tone = { complete: "success", pending: "warning", in_progress: "info" } as const;
  const listed = listedMonths(rows);

  return (
    <div className="space-y-6">
      <div className="max-w-2xl">
        <h1 className="text-[28px] font-semibold tracking-tight">{t("rep.title")}</h1>
        <p className="text-muted">{t("rep.subtitle")}</p>
      </div>
      {rows.every((r) => r.estimatedSales === null) && <EmptyState icon={<FileText className="size-6" aria-hidden />} title={t("rep.noFigures")} body={t("an.none")} />}
      <ul className="grid gap-3">
        {listed.map((r) => (
          <li key={r.month}>
            <Link href={`/reports/${r.month}`} className="flex flex-wrap items-center justify-between gap-3 rounded-[var(--radius-card)] border border-border bg-surface p-4 shadow-soft transition-colors duration-150 hover:bg-surface-soft sm:p-5">
              <div className="min-w-0">
                <p className="text-lg font-semibold">{formatMonth(r.month, locale)}</p>
                <div className="mt-1 flex flex-wrap items-center gap-1.5">
                  <Badge tone={tone[r.status]}>{r.status === "pending" ? t("rep.waiting", { date: formatBusinessDate(r.waitingFor ?? "", locale, { day: "numeric", month: "short" }) }) : t(`rep.status.${r.status}` as MessageKey)}</Badge>
                  {r.recalculated && <Badge tone="info">{t("rep.badge.recalculated")}</Badge>}
                  {r.lastExport && <Badge tone="success">{t("rep.badge.exported", { date: formatShopDateTime(r.lastExport.at, m.timezone) })}</Badge>}
                </div>
              </div>
              <div className="text-right">
                <p className="num text-xl font-semibold">{r.estimatedSales === null ? "—" : formatLkr(r.estimatedSales)}</p>
                <p className="text-xs text-muted">{r.estimatedSales === null ? t("rep.noFigures") : t("an.kpi.sales")}</p>
              </div>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
