import Link from "next/link";
import {
  AlertTriangle, ArrowLeftRight, Boxes, CalendarDays, CheckCircle2, ChevronLeft, ChevronRight, ClipboardCheck, FileText, History, PackagePlus, Wallet,
} from "lucide-react";
import { Button, ButtonLink } from "@/components/ui/button";
import { Card, MetricCard } from "@/components/ui/card";
import { Alert, Badge } from "@/components/ui/feedback";
import { Input, Label } from "@/components/ui/input";
import { alertText } from "@/features/dashboard/alert-text";
import { unitList, type DashAlert } from "@/features/dashboard/summary";
import { addMonths, formatBusinessDate, formatMonth } from "@/lib/dates/business";
import { formatShopDateTime } from "@/lib/dates/format";
import { formatLkr } from "@/lib/formatting/money";
import type { DashboardData } from "@/server/repositories/dashboard";
import type { Locale, MessageKey, Translator } from "@/i18n";

interface Ctx { t: Translator; locale: Locale; timezone: string }

/* ---------- filters: one row above the content they scope ---------- */
export function FilterBar({ data, yesterday, t, locale }: { data: DashboardData; yesterday: string; t: Translator; locale: Locale }) {
  const curMonth = data.today.slice(0, 7);
  const link = (m: string) => `/dashboard?month=${m}${data.salesDate !== yesterday ? `&date=${data.salesDate}` : ""}`;
  const prev = addMonths(data.month, -1);
  const next = addMonths(data.month, 1);
  return (
    <Card className="p-4">
      <form method="get" className="flex flex-wrap items-end gap-3">
        <div className="flex items-end gap-1">
          <Link href={link(prev)} aria-label={t("dash.filter.prevMonth")} className="grid size-11 place-items-center rounded-xl border border-border bg-surface transition-colors duration-150 hover:bg-surface-soft"><ChevronLeft className="size-5" aria-hidden /></Link>
          <div>
            <Label htmlFor="month">{t("dash.filter.month")}</Label>
            <Input id="month" name="month" type="month" defaultValue={data.month} max={curMonth} className="min-w-44" />
          </div>
          {next <= curMonth
            ? <Link href={link(next)} aria-label={t("dash.filter.nextMonth")} className="grid size-11 place-items-center rounded-xl border border-border bg-surface transition-colors duration-150 hover:bg-surface-soft"><ChevronRight className="size-5" aria-hidden /></Link>
            : <span className="grid size-11 place-items-center rounded-xl border border-border opacity-40" aria-hidden><ChevronRight className="size-5" /></span>}
        </div>
        <div>
          <Label htmlFor="date">{t("dash.filter.salesDate")}</Label>
          <Input id="date" name="date" type="date" defaultValue={data.salesDate} max={yesterday} />
        </div>
        <Button type="submit">{t("dash.filter.apply")}</Button>
        {(data.salesDate !== yesterday || data.month !== curMonth) && <ButtonLink href="/dashboard" variant="ghost">{t("dash.filter.reset")}</ButtonLink>}
        <p className="num ml-auto hidden text-sm text-muted md:block">{formatBusinessDate(data.salesDate, locale)} · {formatMonth(data.month, locale)}</p>
      </form>
    </Card>
  );
}

/* ---------- morning stock status: the hero of the page ---------- */
export function MorningCard({ data, canCount, t, locale, timezone }: Ctx & { data: DashboardData; canCount: boolean }) {
  const m = data.morning;
  const done = m.state === "confirmed";
  return (
    <Card className="flex flex-col gap-5 bg-[linear-gradient(135deg,var(--mint),transparent_70%)] md:flex-row md:items-center md:justify-between">
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <ClipboardCheck className="size-5 text-primary" aria-hidden />
          <h2 className="text-lg font-semibold">{t("dash.morning.title")}</h2>
          <Badge tone={done ? "success" : m.state === "draft" ? "info" : "warning"}>
            {t(done ? "ms.status.confirmed" : m.state === "draft" ? "ms.status.draft" : "ms.status.notStarted")}
          </Badge>
        </div>
        <dl className="num grid gap-x-8 gap-y-1 text-[15px] sm:grid-cols-2">
          <div><dt className="text-sm text-muted">{t("dash.morning.countDate")}</dt><dd className="font-semibold">{formatBusinessDate(m.countDate, locale)}</dd></div>
          <div><dt className="text-sm text-muted">{t("dash.morning.salesDate")}</dt><dd className="font-semibold">{formatBusinessDate(m.salesDate, locale)}</dd></div>
        </dl>
        <p className="text-sm text-muted">
          {t("dash.morning.lastCount")}:{" "}
          {m.last ? (
            <Link href={`/stock-history/${m.last.sessionId}`} className="num font-medium text-foreground underline-offset-4 hover:underline">
              {formatBusinessDate(m.last.date, locale, { day: "numeric", month: "short", year: "numeric" })}
              {m.last.confirmedAt ? ` · ${formatShopDateTime(m.last.confirmedAt, timezone).split(", ").pop()}` : ""}{m.last.by ? ` · ${t("dash.morning.by", { name: m.last.by })}` : ""}
            </Link>
          ) : t("dash.morning.never")}
        </p>
      </div>
      <div className="flex flex-col gap-2 md:items-end">
        {canCount ? (
          done ? (
            <>
              <p className="flex items-center gap-2 font-medium"><CheckCircle2 className="size-5 text-success" aria-hidden />{t("dash.morning.doneTitle")}</p>
              {m.sessionId && <ButtonLink href={`/stock-history/${m.sessionId}`} variant="secondary" size="lg">{t("dash.morning.view")}</ButtonLink>}
            </>
          ) : (
            <ButtonLink href="/morning-stock" size="lg" className="w-full md:w-auto md:min-w-64 md:text-lg">
              <ClipboardCheck className="size-5" aria-hidden />{m.state === "draft" ? t("dash.morning.continue") : t("dash.enterMorning")}
            </ButtonLink>
          )
        ) : <p className="max-w-xs text-sm text-muted">{t("dash.morning.readOnly")}</p>}
      </div>
    </Card>
  );
}

/* ---------- KPI tiles ---------- */
const Pending = ({ children }: { children: React.ReactNode }) => <span className="text-[28px] text-muted">{children}</span>;

function UnitsValue({ units }: { units: Record<string, string> }) {
  const list = unitList(units);
  if (list.length === 0) return <>0</>;
  // Different units are listed side by side, never added together.
  return <>{list.map((u) => <span key={u.unit} className="block leading-tight">{Number(u.qty).toLocaleString("en-US")} <span className="text-lg font-medium text-muted">{u.unit}</span></span>)}</>;
}

export function KpiGrid({ data, yesterday, t, locale }: Pick<Ctx, "t" | "locale"> & { data: DashboardData; yesterday: string }) {
  const y = data.yesterday;
  const isY = data.salesDate === yesterday;
  const salesLabel = isY ? t("dash.kpi.yesterdaySales") : t("dash.kpi.salesFor", { date: formatBusinessDate(data.salesDate, locale, { day: "numeric", month: "short" }) });
  const unitsLabel = isY ? t("dash.kpi.yesterdayUnits") : t("dash.kpi.unitsFor", { date: formatBusinessDate(data.salesDate, locale, { day: "numeric", month: "short" }) });

  const hint = (() => {
    if (y.kind === "pending") return t(y.reason === "awaiting_next_count" ? "dash.state.awaiting" : "dash.state.missing");
    if (y.kind === "review") return t("dash.state.reviewHint", { count: y.needsReview });
    if (y.kind === "none") return t("dash.state.none");
    return y.pending > 0 || y.needsReview > 0 ? t("dash.state.partial", { pending: y.pending, review: y.needsReview }) : null;
  })();

  const mt = data.monthTotals;
  const ms = data.monthStatus;
  const monthHint = (
    <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
      {mt.throughDate && <span>{t("dash.kpi.through", { date: formatBusinessDate(mt.throughDate, locale, { day: "numeric", month: "short" }) })}</span>}
      <Badge tone={ms.status === "complete" ? "success" : ms.status === "pending" ? "warning" : "info"}>
        {ms.status === "complete" ? t("dash.month.complete") : ms.status === "in_progress" ? t("dash.month.inProgress") : t("dash.month.pending", { date: formatBusinessDate(ms.waitingFor ?? "", locale, { day: "numeric", month: "short" }) })}
      </Badge>
    </span>
  );
  const monthHas = mt.calculated > 0;
  const v = data.valuation;

  return (
    <section aria-label="Key figures" className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
      <MetricCard label={salesLabel} icon={<Wallet className="size-5" aria-hidden />}
        value={y.kind === "value" ? formatLkr(y.amount) : y.kind === "pending" ? <Pending>{t("dash.state.pending")}</Pending> : y.kind === "review" ? <Pending>{t("dash.state.review")}</Pending> : "—"} hint={hint} />
      <MetricCard label={unitsLabel} icon={<Boxes className="size-5" aria-hidden />}
        value={y.kind === "value" ? <UnitsValue units={y.units} /> : y.kind === "pending" ? <Pending>{t("dash.state.pending")}</Pending> : y.kind === "review" ? <Pending>{t("dash.state.review")}</Pending> : "—"} hint={y.kind === "value" ? null : hint} />
      <MetricCard label={t("dash.kpi.monthSales")} icon={<CalendarDays className="size-5" aria-hidden />} value={monthHas ? formatLkr(mt.amount) : "—"} hint={monthHas ? monthHint : <>{t("dash.kpi.monthNoData")} {monthHint}</>} />
      <MetricCard label={t("dash.kpi.monthUnits")} icon={<Boxes className="size-5" aria-hidden />} value={monthHas ? <UnitsValue units={mt.units} /> : "—"} hint={monthHas && (mt.pending > 0 || mt.needsReview > 0) ? t("dash.state.partial", { pending: mt.pending, review: mt.needsReview }) : null} />
      <MetricCard label={t("dash.kpi.stockValue")} icon={<Wallet className="size-5" aria-hidden />} value={v ? formatLkr(v.totalCost) : "—"}
        hint={v ? <>{t("dash.kpi.stockAsOf", { date: formatBusinessDate(v.asOf, locale, { day: "numeric", month: "short" }) })}{v.uncosted > 0 && <span className="mt-1 block text-warning">{t("dash.kpi.stockUncosted", { count: v.uncosted })}</span>}</> : t("dash.kpi.stockNone")} />
      <MetricCard label={t("dash.kpi.activeProducts")} icon={<PackagePlus className="size-5" aria-hidden />} value={data.activeProducts.toLocaleString("en-US")} hint={t("dash.kpi.activeHint")} />
      <MetricCard label={t("dash.kpi.lowStock")} icon={<AlertTriangle className="size-5" aria-hidden />} value={<span className={data.low.total > 0 ? "text-warning" : undefined}>{data.low.total}</span>} hint={t("dash.kpi.lowHint")} />
      <MetricCard label={t("dash.kpi.pending")} icon={<ClipboardCheck className="size-5" aria-hidden />} value={data.pendingCounts} hint={data.pendingCounts === 0 ? t("dash.kpi.pendingDone") : t("dash.kpi.pendingHint")} />
    </section>
  );
}

/* ---------- alerts / low stock / activity / quick actions ---------- */
export function AlertsCard({ alerts, t, locale }: { alerts: DashAlert[]; t: Translator; locale: Locale }) {
  if (alerts.length === 0) return null;
  return (
    <Card className="space-y-2 p-4" aria-labelledby="alerts-h">
      <h2 id="alerts-h" className="text-base font-semibold">{t("dash.alerts.title")}</h2>
      <ul className="space-y-2">
        {alerts.map((a) => (
          <li key={a.id}>
            <Link href={a.href} className="block rounded-xl transition-opacity duration-150 hover:opacity-90"><Alert tone={a.severity === "warning" ? "warning" : "info"}>{alertText(a, t, locale)}</Alert></Link>
          </li>
        ))}
      </ul>
    </Card>
  );
}

export function LowStockCard({ data, t }: Pick<Ctx, "t"> & { data: DashboardData }) {
  const { items, total } = data.low;
  return (
    <Card id="low-stock" className="scroll-mt-24 space-y-3" aria-labelledby="low-h">
      <div>
        <h2 id="low-h" className="text-lg font-semibold">{t("dash.low.title")}</h2>
        <p className="text-sm text-muted">{t("dash.low.basis")}</p>
      </div>
      {items.length === 0 ? <p className="rounded-2xl bg-surface-soft p-4 text-sm text-muted">{t("dash.low.none")}</p> : (
        <ul className="divide-y divide-border">
          {items.map((i) => {
            const out = Number(i.quantity) === 0;
            return (
              <li key={i.variantId} className="flex items-center justify-between gap-3 py-2.5">
                <div className="min-w-0">
                  <p className="truncate font-medium">{i.name} <span className="font-normal text-muted">{i.size}</span></p>
                  <p className="num text-sm text-muted">{out ? t("dash.low.out") : t("dash.low.left", { qty: i.quantity, unit: i.baseUnit, threshold: i.threshold })}</p>
                </div>
                <Badge tone={out ? "danger" : "warning"}>{out ? t("dash.low.out") : i.quantity}</Badge>
              </li>
            );
          })}
        </ul>
      )}
      {total > items.length && <p className="text-sm text-muted">{t("dash.low.more", { count: total - items.length })}</p>}
    </Card>
  );
}

export function ActivityCard({ data, t, locale, timezone }: Ctx & { data: DashboardData }) {
  return (
    <Card className="space-y-3" aria-labelledby="act-h">
      <h2 id="act-h" className="text-lg font-semibold">{t("dash.activity.title")}</h2>
      {data.activity.length === 0 ? <p className="rounded-2xl bg-surface-soft p-4 text-sm text-muted">{t("dash.activity.none")}</p> : (
        <ul className="divide-y divide-border">
          {data.activity.map((a, i) => (
            <li key={`${a.kind}-${a.at}-${i}`}>
              <Link href={a.href ?? "#"} className="flex items-start gap-3 py-2.5 transition-colors duration-150 hover:bg-surface-soft">
                <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg bg-mint text-mint-foreground">{a.kind === "count" ? <ClipboardCheck className="size-4" aria-hidden /> : <ArrowLeftRight className="size-4" aria-hidden />}</span>
                <span className="min-w-0 flex-1">
                  <span className="block font-medium">{a.kind === "count" ? t("dash.activity.count") : t(`mv.type.${a.title}` as MessageKey)}</span>
                  <span className="num block truncate text-sm text-muted">{a.kind === "count" ? t("dash.activity.countDetail", { date: formatBusinessDate(a.title, locale) }) : a.detail}</span>
                </span>
                <span className="num shrink-0 text-right text-xs text-muted">{formatShopDateTime(a.at, timezone)}{a.by && <><br />{a.by}</>}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

export function QuickActions({ canWrite, canCreateProducts, t }: Pick<Ctx, "t"> & { canWrite: boolean; canCreateProducts: boolean }) {
  const items: { href: string; icon: React.ReactNode; label: string; show: boolean }[] = [
    { href: "/movements/new", icon: <ArrowLeftRight className="size-5" aria-hidden />, label: t("dash.quick.movement"), show: canWrite },
    { href: "/products/new", icon: <PackagePlus className="size-5" aria-hidden />, label: t("cat.products.new"), show: canCreateProducts },
    { href: "/stock-history", icon: <History className="size-5" aria-hidden />, label: t("nav.history"), show: true },
    { href: "/reports", icon: <FileText className="size-5" aria-hidden />, label: t("nav.reports"), show: true },
  ];
  return (
    <Card className="space-y-3" aria-labelledby="quick-h">
      <h2 id="quick-h" className="text-lg font-semibold">{t("dash.quick.title")}</h2>
      <ul className="grid gap-2">
        {items.filter((i) => i.show).map((i) => (
          <li key={i.href}><Link href={i.href} className="flex min-h-11 items-center gap-3 rounded-xl border border-border px-3.5 font-medium transition-colors duration-150 hover:bg-surface-soft">{i.icon}{i.label}</Link></li>
        ))}
      </ul>
    </Card>
  );
}
