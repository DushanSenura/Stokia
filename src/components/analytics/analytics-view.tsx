import Link from "next/link";
import { ProductPicker } from "@/components/analytics/product-picker";
import { MonthlyTrendChart, MovementTrendChart, RankedBarsChart, SalesBarChart, type BarPoint, type MovementPoint } from "@/components/dashboard/sales-charts";
import { Button, ButtonLink } from "@/components/ui/button";
import { Card, MetricCard } from "@/components/ui/card";
import { Alert, Badge } from "@/components/ui/feedback";
import { Input, Label, Select } from "@/components/ui/input";
import { bucketMovements, variantLabel, type Granularity } from "@/features/analytics/aggregate";
import { unitList } from "@/features/dashboard/summary";
import { addDays, addMonths, firstOfMonth, formatBusinessDate, formatMonth, lastOfMonth, monthOf } from "@/lib/dates/business";
import { formatLkr } from "@/lib/formatting/money";
import { sizeLabel } from "@/lib/formatting/units";
import { cn } from "@/lib/utils/cn";
import type { AnalyticsData } from "@/server/repositories/analytics";
import type { Locale, MessageKey, Translator } from "@/i18n";

interface Props {
  data: AnalyticsData; t: Translator; locale: Locale;
  categories: { id: string; name: string }[];
  product: { id: string; label: string } | null;
  productVariants: { id: string; label: string }[];
}

const unitsText = (u: Record<string, string>) => unitList(u).map((x) => `${Number(x.qty).toLocaleString("en-US")} ${x.unit}`).join(" · ");

function qs(data: AnalyticsData, over: Record<string, string | null>) {
  const base: Record<string, string | null> = {
    from: data.range.from, to: data.range.to, category: data.filters.category, product: data.filters.product, variant: data.filters.variant,
    by: data.granularity === "day" ? null : data.granularity, unit: data.movement.unit,
  };
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries({ ...base, ...over })) if (v) u.set(k, v);
  return `/analytics?${u}`;
}

const Pct = ({ v, t }: { v: number | null; t: Translator }) =>
  v === null ? <span className="text-muted">{t("an.compare.noBase")}</span>
    : <Badge tone={v > 0 ? "success" : v < 0 ? "warning" : "neutral"}>{v > 0 ? "+" : ""}{v}%</Badge>;

export function AnalyticsView({ data, t, locale, categories, product, productVariants }: Props) {
  const { range, totals, coverage: cov, compare } = data;
  const today = data.today;
  const curMonth = monthOf(today);
  const yesterday = addDays(today, -1);
  const lastMonth = addMonths(curMonth, -1);
  const presets = [
    { k: "an.preset.thisMonth" as const, from: firstOfMonth(curMonth), to: yesterday < firstOfMonth(curMonth) ? firstOfMonth(lastMonth) : yesterday },
    { k: "an.preset.lastMonth" as const, from: firstOfMonth(lastMonth), to: lastOfMonth(lastMonth) },
    { k: "an.preset.last30" as const, from: addDays(yesterday, -29), to: yesterday },
    { k: "an.preset.last90" as const, from: addDays(yesterday, -89), to: yesterday },
  ];
  // "This month" on the 1st has no days yet; fall back to showing last month so the page is never blank.
  const dayFmt: Intl.DateTimeFormatOptions = { day: "numeric", month: "short" };

  const bars: BarPoint[] = data.series.map((p) => ({
    key: p.key,
    tick: data.granularity === "month" ? formatMonth(monthOf(p.key), locale, "short") : formatBusinessDate(p.key, locale, dayFmt),
    title: data.granularity === "day" ? formatBusinessDate(p.key, locale, { weekday: "short", day: "numeric", month: "short", year: "numeric" })
      : data.granularity === "week" ? t("an.weekOf", { date: formatBusinessDate(p.key, locale, { day: "numeric", month: "short" }) })
      : formatMonth(monthOf(p.key), locale),
    amount: p.amount, status: p.status, units: p.units, calculated: p.calculated, needsReview: p.needsReview, pending: p.pending,
    href: data.granularity === "day" && data.sessionByDate.get(addDays(p.key, 1)) ? `/stock-history/${data.sessionByDate.get(addDays(p.key, 1))}` : null,
  }));

  const movG: Granularity = range.days > 62 ? "week" : "day";
  const movPoints: MovementPoint[] = bucketMovements(data.movement.rows, data.movement.unit, range.from, range.to, movG).map((b) => ({
    ...b, key: b.key, title: movG === "week" ? t("an.weekOf", { date: formatBusinessDate(b.key, locale, dayFmt) }) : formatBusinessDate(b.key, locale, { weekday: "short", day: "numeric", month: "short" }),
    returned: b.returned,
  }));

  const catItems = data.categories.map((c) => ({ id: c.categoryId ?? "none", name: c.name ?? t("an.uncategorised"), amount: Number(c.amount), unitsText: unitsText(c.units), sub: `${c.sharePct}%` }));
  const topItems = data.top.map((v) => ({ id: v.variant_id, name: variantLabel(v), amount: Number(v.estimated_amount), unitsText: `${Number(v.units_sold).toLocaleString("en-US")} ${v.base_unit}` }));

  const th = (k: MessageKey, right = false) => <th key={k} scope="col" className={cn("px-3 py-2.5 font-medium", right && "text-right")}>{t(k)}</th>;

  return (
    <div className="space-y-6">
      <div className="max-w-2xl">
        <h1 className="text-[28px] font-semibold tracking-tight">{t("an.title")}</h1>
        <p className="text-muted">{t("an.subtitle")}</p>
      </div>

      {/* Filters: one row above everything they scope */}
      <Card className="space-y-4 p-4">
        <div className="flex flex-wrap gap-2" role="group" aria-label="Presets">
          {presets.map((p) => (
            <Link key={p.k} href={`/analytics?from=${p.from}&to=${p.to}`} className={cn("inline-flex min-h-11 items-center rounded-xl border px-3.5 text-sm font-medium transition-colors duration-150 hover:bg-surface-soft", range.from === p.from && range.to === p.to ? "border-primary bg-mint text-mint-foreground" : "border-border")}>{t(p.k)}</Link>
          ))}
        </div>
        <form method="get" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-[repeat(5,minmax(0,1fr))_auto] lg:items-end">
          <div><Label htmlFor="from">{t("an.from")}</Label><Input id="from" name="from" type="date" defaultValue={range.from} max={yesterday} /></div>
          <div><Label htmlFor="to">{t("an.to")}</Label><Input id="to" name="to" type="date" defaultValue={range.to} max={yesterday} /></div>
          <div>
            <Label htmlFor="category">{t("an.category")}</Label>
            <Select id="category" name="category" defaultValue={data.filters.category ?? ""}>
              <option value="">{t("an.allCategories")}</option>
              {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </Select>
          </div>
          <ProductPicker name="product" initial={product} />
          <div>
            <Label htmlFor="variant">{t("an.variant")}</Label>
            <Select id="variant" name="variant" defaultValue={data.filters.variant ?? ""} disabled={productVariants.length === 0}>
              <option value="">{t("an.allSizes")}</option>
              {productVariants.map((v) => <option key={v.id} value={v.id}>{v.label}</option>)}
            </Select>
          </div>
          <div className="flex gap-2"><Button type="submit">{t("an.apply")}</Button><ButtonLink href="/analytics" variant="ghost">{t("an.reset")}</ButtonLink></div>
        </form>
        {range.clamped && <Alert tone="info">{t("an.clamped")}</Alert>}
      </Card>

      {data.error && <Alert tone="danger">{t("an.error")}</Alert>}

      {/* Headline figures */}
      <section aria-label="Key figures" className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard label={t("an.kpi.sales")} value={cov.withFigures > 0 ? formatLkr(totals.amount) : "—"} hint={`${formatBusinessDate(range.from, locale, dayFmt)} – ${formatBusinessDate(range.to, locale, dayFmt)}`} />
        <MetricCard label={t("an.kpi.units")} value={Object.keys(totals.units).length ? unitList(totals.units).map((u) => <span key={u.unit} className="block leading-tight">{Number(u.qty).toLocaleString("en-US")} <span className="text-lg font-medium text-muted">{u.unit}</span></span>) : "—"} />
        <MetricCard label={t("an.kpi.best")} value={totals.best ? formatLkr(totals.best.amount) : "—"} hint={totals.best ? formatBusinessDate(totals.best.date, locale) : null} />
        <MetricCard label={t("an.kpi.coverage")} value={t("an.coverage", { with: cov.withFigures, days: cov.days })} hint={t("an.coverageDetail", { partial: cov.partial, review: cov.reviewOnly, pending: cov.pendingOnly, none: cov.none })} />
      </section>

      {/* Sales over time */}
      <div className="space-y-3">
        <div role="group" aria-label={t("an.by")} className="inline-flex gap-1 rounded-xl bg-surface-soft p-1">
          {(["day", "week", "month"] as const).map((g) => (
            <Link key={g} href={qs(data, { by: g === "day" ? null : g })} aria-current={data.granularity === g ? "true" : undefined}
              className={cn("inline-flex min-h-11 items-center rounded-lg px-4 text-sm font-medium transition-colors duration-150", data.granularity === g ? "bg-surface shadow-soft" : "text-muted hover:text-foreground")}>{t(`an.by.${g}` as MessageKey)}</Link>
          ))}
        </div>
        <SalesBarChart id="an-sales" points={bars} title={t(`an.sales.${data.granularity}` as MessageKey)} subtitle={`${formatBusinessDate(range.from, locale)} – ${formatBusinessDate(range.to, locale)}`} ariaLabel={t(`an.sales.${data.granularity}` as MessageKey)} />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="space-y-4 lg:col-span-1" aria-labelledby="mom-h">
          <div>
            <h2 id="mom-h" className="text-lg font-semibold">{t("an.compare.title")}</h2>
            <p className="text-sm text-muted">
              {compare.throughDay ? t("an.compare.like", { month: formatMonth(compare.month, locale), previous: formatMonth(compare.previous, locale), days: compare.throughDay })
                : t("an.compare.full", { month: formatMonth(compare.month, locale), previous: formatMonth(compare.previous, locale) })}
            </p>
          </div>
          <div>
            <p className="text-sm text-muted">{t("an.compare.sales")}</p>
            <p className="num text-3xl font-semibold">{formatLkr(compare.current.amount)}</p>
            <p className="num mt-1 flex flex-wrap items-center gap-2 text-sm text-muted"><Pct v={compare.amountChangePct} t={t} /> {t("an.compare.vs", { current: formatLkr(compare.current.amount), prior: formatLkr(compare.prior.amount) })}</p>
          </div>
          {compare.unitChanges.length > 0 && (
            <ul className="divide-y divide-border text-sm">
              {compare.unitChanges.map((u) => (
                <li key={u.unit} className="flex items-center justify-between gap-3 py-2"><span className="num">{Number(u.current).toLocaleString("en-US")} {u.unit} <span className="text-muted">({Number(u.prior).toLocaleString("en-US")})</span></span><Pct v={u.changePct} t={t} /></li>
              ))}
            </ul>
          )}
        </Card>
        <div className="min-w-0 lg:col-span-2"><MonthlyTrendChart points={data.trend} /></div>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <RankedBarsChart id="an-cat" title={t("an.categories.title")} subtitle={t("an.categories.sub")} items={catItems} nameHeader={t("an.col.category")} valueHeader={t("an.col.sales")} />
        <RankedBarsChart id="an-top" title={t("an.top.title")} subtitle={t("an.categories.sub")} items={topItems} nameHeader={t("an.col.product")} valueHeader={t("an.col.sales")} />
      </div>

      {/* Tables */}
      <Card className="space-y-3 p-0" aria-labelledby="prod-h">
        <h2 id="prod-h" className="px-5 pt-5 text-lg font-semibold">{t("an.products.title")}</h2>
        <div tabIndex={0} className="overflow-x-auto">
          <table className="num w-full min-w-[40rem] text-left text-sm">
            <thead className="border-y border-border text-muted"><tr>{th("an.col.product")}{th("an.col.category")}{th("an.col.units", true)}{th("an.col.sales", true)}{th("an.col.review", true)}</tr></thead>
            <tbody>
              {data.products.length === 0 && <tr><td colSpan={5} className="px-3 py-6 text-center text-muted">{t("an.none")}</td></tr>}
              {data.products.map((p) => (
                <tr key={p.productId} className="border-t border-border">
                  <td className="px-3 py-2.5 font-medium">{p.name} <span className="font-normal text-muted">({p.variants})</span></td>
                  <td className="px-3 py-2.5 text-muted">{p.categoryName ?? t("an.uncategorised")}</td>
                  <td className="px-3 py-2.5 text-right">{unitsText(p.units) || "—"}</td>
                  <td className="px-3 py-2.5 text-right font-semibold">{formatLkr(p.amount)}</td>
                  <td className="px-3 py-2.5 text-right">{p.daysReview || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Card className="space-y-3 p-0" aria-labelledby="var-h">
        <h2 id="var-h" className="px-5 pt-5 text-lg font-semibold">{t("an.variants.title")}</h2>
        <div tabIndex={0} className="overflow-x-auto">
          <table className="num w-full min-w-[44rem] text-left text-sm">
            <thead className="border-y border-border text-muted"><tr>{th("an.col.product")}{th("an.col.size")}{th("an.col.units", true)}{th("an.col.sales", true)}{th("an.col.days", true)}{th("an.col.review", true)}</tr></thead>
            <tbody>
              {data.variants.length === 0 && <tr><td colSpan={6} className="px-3 py-6 text-center text-muted">{t("an.none")}</td></tr>}
              {data.variants.slice(0, 200).map((v) => (
                <tr key={v.variant_id} className="border-t border-border">
                  <td className="px-3 py-2.5 font-medium">{v.product_name}</td>
                  <td className="px-3 py-2.5 text-muted">{sizeLabel(v.size_value, v.size_unit) || v.sku}</td>
                  <td className="px-3 py-2.5 text-right">{Number(v.units_sold).toLocaleString("en-US")} {v.base_unit}</td>
                  <td className="px-3 py-2.5 text-right font-semibold">{formatLkr(v.estimated_amount)}</td>
                  <td className="px-3 py-2.5 text-right">{v.days_calculated}</td>
                  <td className="px-3 py-2.5 text-right">{v.days_review || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {data.variants.length > 200 && <p className="px-5 pb-4 text-sm text-muted">{data.variants.length - 200} …</p>}
      </Card>

      <Card className="space-y-3 p-0" aria-labelledby="slow-h">
        <div className="px-5 pt-5"><h2 id="slow-h" className="text-lg font-semibold">{t("an.slow.title")}</h2><p className="text-sm text-muted">{t("an.slow.sub")}</p></div>
        <div tabIndex={0} className="overflow-x-auto">
          <table className="num w-full min-w-[32rem] text-left text-sm">
            <thead className="border-y border-border text-muted"><tr>{th("an.col.product")}{th("an.col.units", true)}{th("an.col.sales", true)}{th("an.col.days", true)}</tr></thead>
            <tbody>
              {data.slow.length === 0 && <tr><td colSpan={4} className="px-3 py-6 text-center text-muted">{t("an.none")}</td></tr>}
              {data.slow.map((v) => (
                <tr key={v.variant_id} className="border-t border-border">
                  <td className="px-3 py-2.5 font-medium">{variantLabel(v)}</td>
                  <td className="px-3 py-2.5 text-right">{Number(v.units_sold).toLocaleString("en-US")} {v.base_unit}</td>
                  <td className="px-3 py-2.5 text-right font-semibold">{formatLkr(v.estimated_amount)}</td>
                  <td className="px-3 py-2.5 text-right">{v.days_calculated}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <div className="space-y-3">
        {data.movement.units.length > 1 && (
          <div role="group" aria-label={t("an.movementUnit")} className="inline-flex gap-1 rounded-xl bg-surface-soft p-1">
            {data.movement.units.map((u) => (
              <Link key={u} href={qs(data, { unit: u })} aria-current={data.movement.unit === u ? "true" : undefined} className={cn("inline-flex min-h-11 items-center rounded-lg px-4 text-sm font-medium transition-colors duration-150", data.movement.unit === u ? "bg-surface shadow-soft" : "text-muted hover:text-foreground")}>{u}</Link>
            ))}
          </div>
        )}
        <MovementTrendChart points={movPoints} unit={data.movement.unit ?? "—"} />
      </div>

      <p className="text-sm text-muted">{t("sales.estimateNote")}</p>
    </div>
  );
}

