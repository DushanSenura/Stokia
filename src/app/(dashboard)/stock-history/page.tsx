import type { Metadata } from "next";
import Link from "next/link";
import { Download, History } from "lucide-react";
import { Button, ButtonLink } from "@/components/ui/button";
import { Badge, EmptyState } from "@/components/ui/feedback";
import { Card } from "@/components/ui/card";
import { Input, Label } from "@/components/ui/input";
import { getTranslator } from "@/i18n/server";
import { formatBusinessDate, isBusinessDate, salesDateFor } from "@/lib/dates/business";
import { formatShopDateTime } from "@/lib/dates/format";
import { createClient } from "@/lib/supabase/server";
import { HISTORY_PAGE_SIZE, listSessions } from "@/server/repositories/inventory";
import { getSessionContext } from "@/server/services/session";
import type { MessageKey } from "@/i18n";

export const metadata: Metadata = { title: "Stock History" };
const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
const tone = { draft: "info", needs_review: "warning", confirmed: "success", corrected: "neutral" } as const;
const statusKey = { draft: "ms.status.draft", needs_review: "ms.status.needsReview", confirmed: "ms.status.confirmed", corrected: "ms.status.corrected" } as const;

export default async function StockHistoryPage({ searchParams }: PageProps<"/stock-history">) {
  const { t, locale } = await getTranslator();
  const sp = await searchParams;
  const m = (await getSessionContext()).membership!;
  const from = isBusinessDate(first(sp.from)) ? first(sp.from) : undefined;
  const to = isBusinessDate(first(sp.to)) ? first(sp.to) : undefined;
  const page = Math.max(1, Number(first(sp.page)) || 1);

  const { rows, total, error, tally, people } = await listSessions(await createClient(), { from, to, page });
  const pages = Math.max(1, Math.ceil(total / HISTORY_PAGE_SIZE));
  const qs = (p: number, extra: Record<string, string> = {}) => {
    const u = new URLSearchParams({ ...(from ? { from } : {}), ...(to ? { to } : {}), ...(p > 1 ? { page: String(p) } : {}), ...extra });
    return u.toString() ? `?${u}` : "";
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-[28px] font-semibold tracking-tight">{t("sh.title")}</h1>
          <p className="text-muted">{t("sh.subtitle")}</p>
        </div>
        <ButtonLink href={`/api/exports/stock-history${qs(1)}`} variant="secondary" prefetch={false}><Download className="size-4" aria-hidden />{t("sh.export")}</ButtonLink>
      </div>

      <Card>
        <form method="get" className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
          <div><Label htmlFor="from">{t("sh.from")}</Label><Input id="from" name="from" type="date" defaultValue={from} /></div>
          <div><Label htmlFor="to">{t("sh.to")}</Label><Input id="to" name="to" type="date" defaultValue={to} /></div>
          <Button type="submit">{t("sh.filter")}</Button>
        </form>
      </Card>

      {error ? (
        <EmptyState title={t("error.title")} body={t("error.body")} />
      ) : rows.length === 0 ? (
        <EmptyState icon={<History className="size-6" aria-hidden />} title={t("sh.empty")} action={<ButtonLink href="/morning-stock">{t("dash.enterMorning")}</ButtonLink>} />
      ) : (
        <>
          <p className="text-sm text-muted" aria-live="polite">{t("common.results", { count: total })}</p>
          <div tabIndex={0} className="overflow-x-auto rounded-[var(--radius-card)] border border-border bg-surface shadow-soft">
            <table className="w-full min-w-[44rem] text-left text-sm">
              <thead className="border-b border-border text-muted">
                <tr>{(["sh.col.date", "sh.col.salesDate", "sh.col.status", "sh.col.counted", "sh.col.notCounted", "sh.col.by", "sh.col.at"] as MessageKey[]).map((k) => <th key={k} scope="col" className="px-4 py-3 font-medium">{t(k)}</th>)}</tr>
              </thead>
              <tbody className="num">
                {rows.map((r) => {
                  const c = tally.get(r.id) ?? { counted: 0, notCounted: 0 };
                  return (
                    <tr key={r.id} className="border-t border-border transition-colors duration-150 hover:bg-surface-soft">
                      <td className="px-4 py-3 font-medium"><Link href={`/stock-history/${r.id}`} className="text-action underline-offset-4 hover:underline dark:text-sage">{formatBusinessDate(r.business_date, locale, { day: "numeric", month: "short", year: "numeric" })}</Link></td>
                      <td className="px-4 py-3">{formatBusinessDate(salesDateFor(r.business_date), locale, { day: "numeric", month: "short", year: "numeric" })}</td>
                      <td className="px-4 py-3"><Badge tone={tone[r.status]}>{t(statusKey[r.status])}</Badge></td>
                      <td className="px-4 py-3">{r.status === "draft" ? "—" : c.counted}</td>
                      <td className="px-4 py-3">{r.status === "draft" ? "—" : c.notCounted}</td>
                      <td className="px-4 py-3">{people.get(r.confirmed_by ?? "") ?? "—"}</td>
                      <td className="px-4 py-3">{r.confirmed_at ? formatShopDateTime(r.confirmed_at, m.timezone) : "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {pages > 1 && (
            <nav aria-label="Pagination" className="flex items-center justify-between gap-3">
              {page > 1 ? <ButtonLink href={`/stock-history${qs(page - 1)}`} variant="secondary">{t("common.previous")}</ButtonLink> : <span />}
              <span className="num text-sm text-muted">{t("common.pageOf", { page, pages })}</span>
              {page < pages ? <ButtonLink href={`/stock-history${qs(page + 1)}`} variant="secondary">{t("common.next")}</ButtonLink> : <span />}
            </nav>
          )}
        </>
      )}
    </div>
  );
}
