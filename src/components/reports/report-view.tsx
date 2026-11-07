import Link from "next/link";
import { ReportActions } from "@/components/reports/report-actions";
import { ButtonLink } from "@/components/ui/button";
import { Alert, Badge } from "@/components/ui/feedback";
import { unitList } from "@/features/dashboard/summary";
import { generatedText, hasPackagingSection } from "@/features/reports/labels";
import { noteSentence } from "@/features/reports/note-text";
import type { MonthlyReport } from "@/features/reports/report";
import { formatBusinessDate, formatMonth } from "@/lib/dates/business";
import { formatShopDateTime } from "@/lib/dates/format";
import { formatLkr } from "@/lib/formatting/money";
import { cn } from "@/lib/utils/cn";
import type { Locale, MessageKey, Translator } from "@/i18n";

const q = (v: string | null) => (v === null ? "—" : Number(v).toLocaleString("en-US", { maximumFractionDigits: 3 }));
const money = (v: string | null) => (v === null ? "—" : formatLkr(v));

// The wording lives in a pure module so the phone app shows identical sentences; re-exported for existing imports.
export { noteSentence };

const Section = ({ id, title, sub, children }: { id: string; title: string; sub?: string; children: React.ReactNode }) => (
  <section aria-labelledby={id} className="break-inside-avoid-page space-y-2">
    <div><h2 id={id} className="text-xl font-semibold">{title}</h2>{sub && <p className="text-sm text-muted">{sub}</p>}</div>
    {children}
  </section>
);

const TableWrap = ({ children, min = "40rem" }: { children: React.ReactNode; min?: string }) => (
  <div tabIndex={0} className="overflow-x-auto rounded-[var(--radius-card)] border border-border bg-surface print:overflow-visible print:rounded-none print:border-0">
    <table className="num w-full text-left text-sm print:text-[10px]" style={{ minWidth: min }}>{children}</table>
  </div>
);
const Th = ({ children, right }: { children: React.ReactNode; right?: boolean }) => <th scope="col" className={cn("px-3 py-2.5 font-medium", right && "text-right")}>{children}</th>;

/**
 * The monthly report: the same model that feeds the PDF / Excel / CSV exports. Designed to print cleanly:
 * app chrome and controls are hidden in print, colours fall back to black on white.
 */
export function ReportView({ report: r, t, locale, timezone }: { report: MonthlyReport; t: Translator; locale: Locale; timezone: string }) {
  const statusTone = r.status.kind === "complete" ? "success" : r.status.kind === "pending" ? "warning" : "info";
  const flagText = (v: MonthlyReport["variants"][number]) =>
    [v.flags.missingOpening && t("rep.flag.noOpening"), v.flags.missingClosing && t("rep.flag.noClosing"), v.flags.review && t("rep.flag.review"), v.flags.pendingDays && t("rep.flag.pending"), v.flags.uncosted && t("rep.flag.noCost")].filter(Boolean).join(", ");

  return (
    <article className="mx-auto max-w-6xl space-y-8">
      <header className="space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-sm font-semibold text-action dark:text-primary print:text-black">Stokia <span className="font-normal text-muted">· {t("brand.tagline")}</span></p>
            <h1 className="text-[28px] font-semibold tracking-tight">{t("rep.report.title", { month: formatMonth(r.month, locale) })}</h1>
            <p className="text-muted">{r.shopName} · {t("rep.period")}: <span className="num">{formatBusinessDate(r.period.from, locale)} – {formatBusinessDate(r.period.to, locale)}</span></p>
            <p className="num text-sm text-muted">{t("rep.generated", { when: generatedText(r) })} · LKR</p>
          </div>
          <ButtonLink href="/reports" variant="ghost" className="print:hidden">{t("rep.back")}</ButtonLink>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={statusTone}>{r.status.kind === "pending" ? t("rep.waiting", { date: formatBusinessDate(r.status.waitingFor ?? "", locale) }) : t(`rep.status.${r.status.kind}` as MessageKey)}</Badge>
          {r.recalculated && <Badge tone="info">{t("rep.badge.recalculated")}</Badge>}
          {r.lastExport && (r.lastExport.stale
            ? <Badge tone="warning">{t("rep.badge.changed")}</Badge>
            : <Badge tone="success">{t("rep.badge.exported", { date: formatShopDateTime(r.lastExport.at, timezone) })}</Badge>)}
        </div>
        {r.lastExport?.stale && <Alert tone="warning" className="print:hidden">{t("rep.badStatus.stale")}</Alert>}

        <ReportActions month={r.month} />
        <p className="text-xs text-muted print:hidden">{t("rep.exportNote")}</p>
      </header>

      <Alert tone="info" className="break-inside-avoid"><div><p className="font-semibold">{t("rep.basisTitle")}</p><p className="mt-1">{t("rep.basis")}</p></div></Alert>

      {r.notes.length > 0 && (
        <ul className="space-y-2">
          {r.notes.map((n) => <li key={n.code}><Alert tone={n.code === "in_progress" || n.code === "recalculated" ? "info" : "warning"}>{noteSentence(n, t, locale)}</Alert></li>)}
        </ul>
      )}

      <Section id="sum" title={t("rep.section.summary")}>
        <div className="grid gap-4 sm:grid-cols-3">
          <div className="rounded-[var(--radius-card)] border border-border bg-surface p-5">
            <p className="text-sm text-muted">{t("rep.sales")}</p>
            <p className="num text-3xl font-semibold">{money(r.totals.estimatedSales)}</p>
            <p className="mt-1 text-xs text-muted">{t("rep.salesHint")}</p>
          </div>
          <div className="rounded-[var(--radius-card)] border border-border bg-surface p-5">
            <p className="text-sm text-muted">{t("rep.closingValue")}</p>
            <p className="num text-3xl font-semibold">{r.status.kind === "in_progress" || r.stock.every((u) => u.withoutClosing === u.variants) ? "—" : money(r.totals.closingValue)}</p>
            <p className="mt-1 text-xs text-muted">{t("rep.closingValueHint", { date: formatBusinessDate(r.closingCountDate, locale) })}</p>
          </div>
          <div className="rounded-[var(--radius-card)] border border-border bg-surface p-5">
            <p className="text-sm text-muted">{t("rep.days")}</p>
            <p className="num text-3xl font-semibold">{r.totals.daysCalculated.toLocaleString("en-US")}</p>
            <p className="mt-1 text-xs text-muted">{t("rep.daysHint", { review: r.totals.daysReview, pending: r.totals.daysPending })}</p>
          </div>
        </div>
      </Section>

      {hasPackagingSection(r) && (
        <Section id="pk" title={t("rep.pk.title")} sub={t("rep.pk.help")}>
          <div className="grid gap-4 sm:grid-cols-3">
            {(["known", "unknown", "standard"] as const).map((b) => (
              <div key={b} className={cn("rounded-[var(--radius-card)] border bg-surface p-5", b === "known" ? "border-success/50" : "border-border")}>
                <p className="text-sm font-medium">{t(`rep.pk.${b}` as MessageKey)}</p>
                <p className="num text-2xl font-semibold">{money(r.packaging[b].amount)}</p>
                <p className="num text-xs text-muted">
                  {t("rep.pk.days", { count: r.packaging[b].productDays })}
                  {unitList(r.packaging[b].units).length > 0 && <> · {unitList(r.packaging[b].units).map((u) => t("rep.pk.units", { units: `${q(u.qty)} ${u.unit}` })).join(" · ")}</>}
                </p>
                <p className="mt-1 text-xs text-muted">{t(`rep.pk.${b}Help` as MessageKey)}</p>
              </div>
            ))}
          </div>
          <p className="num text-sm text-muted">{t("rep.pk.total")}: <span className="font-semibold text-foreground">{money(r.packaging.total)}</span></p>

          {r.packaging.knownProducts.length > 0 ? (
            <>
              <h3 className="pt-2 font-semibold">{t("rep.pk.breakdownTitle")}</h3>
              <TableWrap min="36rem">
                <thead className="border-b border-border text-muted"><tr><Th>{t("rep.pk.col.product")}</Th><Th right>{t("rep.pk.col.sold")}</Th><Th>{t("rep.pk.col.mix")}</Th><Th right>{t("rep.pk.col.amount")}</Th></tr></thead>
                <tbody>
                  {r.packaging.knownProducts.map((k) => (
                    <tr key={k.sku} className="border-t border-border align-top">
                      <td className="px-3 py-2.5 font-medium">{k.name}<br /><span className="font-normal text-muted">{k.sku}</span></td>
                      <td className="px-3 py-2.5 text-right">{q(k.unitsSold)} {k.unit}</td>
                      <td className="px-3 py-2.5">{k.packages.map((x) => `${q(x.quantity)} ${x.name}`).join(" · ")}</td>
                      <td className="whitespace-nowrap px-3 py-2.5 text-right font-semibold">{money(k.amount)}</td>
                    </tr>
                  ))}
                </tbody>
              </TableWrap>
              {r.packaging.daily.length > 0 && (
                <TableWrap min="26rem">
                  <thead className="border-b border-border text-muted"><tr><Th>{t("rep.col.date")}</Th><Th right>{t("rep.pk.daily.known")}</Th><Th right>{t("rep.pk.daily.estimated")}</Th></tr></thead>
                  <tbody>
                    {r.packaging.daily.map((d) => (
                      <tr key={d.date} className="border-t border-border">
                        <td className="px-3 py-2">{formatBusinessDate(d.date, locale, { weekday: "short", day: "numeric", month: "short" })}</td>
                        <td className="whitespace-nowrap px-3 py-2 text-right font-semibold">{money(d.known)}</td>
                        <td className="whitespace-nowrap px-3 py-2 text-right">{money(d.estimated)}</td>
                      </tr>
                    ))}
                  </tbody>
                </TableWrap>
              )}
            </>
          ) : <p className="rounded-2xl bg-surface-soft p-4 text-sm text-muted">{t("rep.pk.noneKnown")}</p>}
        </Section>
      )}

      <Section id="stock" title={t("rep.section.stock")} sub={t("rep.section.stockSub")}>
        <TableWrap min="52rem">
          <thead className="border-b border-border text-muted"><tr><Th>{t("rep.col.unit")}</Th><Th right>{t("rep.col.products")}</Th><Th right>{t("rep.col.opening")}</Th><Th right>{t("rep.col.received")}</Th><Th right>{t("rep.col.returns")}</Th><Th right>{t("rep.col.damaged")}</Th><Th right>{t("rep.col.supplier")}</Th><Th right>{t("rep.col.adjust")}</Th><Th right>{t("rep.col.closing")}</Th><Th right>{t("rep.col.sold")}</Th><Th right>{t("rep.col.unreconciled")}</Th></tr></thead>
          <tbody>
            {r.stock.length === 0 && <tr><td colSpan={11} className="px-3 py-6 text-center text-muted">{t("rep.noRows")}</td></tr>}
            {r.stock.map((u) => (
              <tr key={u.unit} className="border-t border-border">
                <td className="px-3 py-2.5 font-medium">{u.unit}</td><td className="px-3 py-2.5 text-right">{u.variants}</td>
                <td className="px-3 py-2.5 text-right">{q(u.opening)}</td><td className="px-3 py-2.5 text-right">{q(u.received)}</td><td className="px-3 py-2.5 text-right">{q(u.returnedIn)}</td>
                <td className="px-3 py-2.5 text-right">{q(u.damagedOut)}</td><td className="px-3 py-2.5 text-right">{q(u.otherOut)}</td><td className="px-3 py-2.5 text-right">{q(u.adjustments)}</td>
                <td className="px-3 py-2.5 text-right">{q(u.closing)}</td><td className="px-3 py-2.5 text-right font-semibold">{q(u.unitsSold)}</td>
                <td className={cn("px-3 py-2.5 text-right", Number(u.unreconciled) !== 0 && "font-semibold text-warning print:text-black")}>{q(u.unreconciled)}</td>
              </tr>
            ))}
          </tbody>
        </TableWrap>
        <p className="text-xs text-muted">{t("rep.unreconciledHelp")}</p>
      </Section>

      <Section id="cat" title={t("rep.section.categories")}>
        <TableWrap min="32rem">
          <thead className="border-b border-border text-muted"><tr><Th>{t("an.col.category")}</Th><Th right>{t("rep.col.products")}</Th><Th right>{t("an.col.units")}</Th><Th right>{t("an.col.sales")}</Th><Th right>{t("an.col.share")}</Th></tr></thead>
          <tbody>
            {r.categories.length === 0 && <tr><td colSpan={5} className="px-3 py-6 text-center text-muted">{t("rep.noRows")}</td></tr>}
            {r.categories.map((c) => (
              <tr key={c.categoryId ?? "none"} className="border-t border-border">
                <td className="px-3 py-2.5 font-medium">{c.name ?? t("an.uncategorised")}</td><td className="px-3 py-2.5 text-right">{c.products}</td>
                <td className="px-3 py-2.5 text-right">{unitList(c.units).map((u) => `${q(u.qty)} ${u.unit}`).join(" · ") || "—"}</td>
                <td className="whitespace-nowrap px-3 py-2.5 text-right font-semibold">{money(c.amount)}</td><td className="px-3 py-2.5 text-right">{c.sharePct.toFixed(1)}%</td>
              </tr>
            ))}
          </tbody>
        </TableWrap>
      </Section>

      <Section id="prod" title={t("rep.section.products")}>
        <TableWrap min="70rem">
          <thead className="border-b border-border text-muted"><tr><Th>{t("an.col.product")}</Th><Th>{t("an.col.size")}</Th><Th right>{t("rep.col.opening")}</Th><Th right>{t("rep.col.received")}</Th><Th right>{t("rep.col.returns")}</Th><Th right>{t("rep.col.damaged")}</Th><Th right>{t("rep.col.adjust")}</Th><Th right>{t("rep.col.closing")}</Th><Th right>{t("rep.col.sold")}</Th><Th right>{t("rep.sales")}</Th><Th right>{t("rep.col.value")}</Th><Th>{t("rep.col.notes")}</Th></tr></thead>
          <tbody>
            {r.variants.length === 0 && <tr><td colSpan={12} className="px-3 py-6 text-center text-muted">{t("rep.noRows")}</td></tr>}
            {r.variants.map((v) => (
              <tr key={v.variantId} className="border-t border-border align-top">
                <td className="px-3 py-2.5 font-medium">{v.productName}<br /><span className="font-normal text-muted">{v.categoryName ?? t("an.uncategorised")}</span></td>
                <td className="px-3 py-2.5">{v.size || v.sku}<br /><span className="text-muted">{v.unit}</span></td>
                <td className="px-3 py-2.5 text-right">{q(v.opening)}</td><td className="px-3 py-2.5 text-right">{q(v.received)}</td><td className="px-3 py-2.5 text-right">{q(v.returnedIn)}</td>
                <td className="px-3 py-2.5 text-right">{q(v.damagedOut)}</td><td className="px-3 py-2.5 text-right">{q(v.adjustments)}</td><td className="px-3 py-2.5 text-right">{q(v.closing)}</td>
                <td className="px-3 py-2.5 text-right font-semibold">{q(v.unitsSold)}</td><td className="whitespace-nowrap px-3 py-2.5 text-right font-semibold">{money(v.estimatedAmount)}</td>
                <td className="whitespace-nowrap px-3 py-2.5 text-right">{money(v.closingValue)}</td>
                <td className="px-3 py-2.5 text-xs text-muted">{flagText(v)}</td>
              </tr>
            ))}
          </tbody>
        </TableWrap>
      </Section>

      <Section id="daily" title={t("rep.section.daily")} sub={t("rep.section.dailySub")}>
        <TableWrap min="30rem">
          <thead className="border-b border-border text-muted"><tr><Th>{t("rep.col.date")}</Th><Th right>{t("an.col.sales")}</Th><Th right>{t("an.col.units")}</Th><Th>{t("rep.col.status")}</Th></tr></thead>
          <tbody>
            {r.daily.filter((d) => d.status !== "none").map((d) => (
              <tr key={d.key} className="border-t border-border">
                <td className="px-3 py-2">{formatBusinessDate(d.key, locale, { weekday: "short", day: "numeric", month: "short" })}</td>
                <td className="whitespace-nowrap px-3 py-2 text-right">{d.amount === null ? "—" : money(String(d.amount))}</td>
                <td className="px-3 py-2 text-right">{unitList(d.units).map((u) => `${q(u.qty)} ${u.unit}`).join(" · ") || "—"}</td>
                <td className="px-3 py-2">{t(({ calculated: "dash.chart.legend.calculated", partial: "dash.chart.legend.partial", review: "dash.chart.legend.review", pending: "dash.chart.legend.pending", none: "dash.chart.noBar" } as const)[d.status])}</td>
              </tr>
            ))}
          </tbody>
        </TableWrap>
      </Section>

      <Section id="low" title={t("rep.section.lowStock")} sub={t("rep.section.lowStockSub")}>
        {r.lowStock.length === 0 ? <p className="rounded-2xl bg-surface-soft p-4 text-sm text-muted">{t("rep.noLowStock")}</p> : (
          <TableWrap min="28rem">
            <thead className="border-b border-border text-muted"><tr><Th>{t("an.col.product")}</Th><Th>{t("an.col.size")}</Th><Th right>{t("rep.col.qty")}</Th><Th right>{t("rep.col.level")}</Th></tr></thead>
            <tbody>{r.lowStock.map((x) => <tr key={x.sku} className="border-t border-border"><td className="px-3 py-2 font-medium">{x.name}</td><td className="px-3 py-2 text-muted">{x.size || x.sku}</td><td className="px-3 py-2 text-right">{q(x.quantity)} {x.unit}</td><td className="px-3 py-2 text-right">{q(x.threshold)}</td></tr>)}</tbody>
          </TableWrap>
        )}
      </Section>

      <p className="text-xs text-muted print:text-black"><Link href="/reports" className="print:hidden">{t("rep.back")}</Link></p>
    </article>
  );
}
