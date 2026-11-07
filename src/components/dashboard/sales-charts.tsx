"use client";

import { useReducedMotion } from "motion/react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Bar, BarChart, CartesianGrid, Cell, LabelList, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Card } from "@/components/ui/card";
import { unitList, type DailyPoint, type DayStatus, type MonthPoint } from "@/features/dashboard/summary";
import { formatBusinessDate, formatMonth } from "@/lib/dates/business";
import { formatLkr } from "@/lib/formatting/money";
import { useI18n } from "@/providers/i18n-provider";
import type { TopProduct } from "@/server/repositories/dashboard";
import type { MessageKey } from "@/i18n";

/* ---------- shared pieces ---------- */

const statusKey: Record<DayStatus, MessageKey> = {
  calculated: "dash.chart.legend.calculated", partial: "dash.chart.legend.partial", review: "dash.chart.legend.review",
  pending: "dash.chart.legend.pending", none: "dash.chart.noBar",
};

const axisMoney = (v: number) => (v >= 10_000 ? new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(v) : v.toLocaleString("en-US"));
const tick = { fill: "var(--muted)", fontSize: 12 };

/** Hatch patterns carry meaning with texture, not just colour (colour-blind safe; survives print and forced colours). */
function Patterns() {
  const mk = (id: string, stroke: string) => (
    <pattern id={id} width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
      <rect width="6" height="6" style={{ fill: "var(--surface)" }} />
      <line x1="0" y1="0" x2="0" y2="6" strokeWidth="2.5" style={{ stroke }} />
    </pattern>
  );
  return <defs>{mk("hatch-calc", "var(--viz-calc)")}{mk("hatch-review", "var(--viz-review)")}{mk("hatch-pending", "var(--viz-pending)")}</defs>;
}

function Swatch({ kind }: { kind: "solid" | "hatch-calc" | "hatch-review" | "hatch-pending" | "dot" | "ring" }) {
  const base = "inline-block size-3 shrink-0 rounded-[3px]";
  if (kind === "solid") return <span aria-hidden className={base} style={{ background: "var(--viz-calc)" }} />;
  if (kind === "dot") return <span aria-hidden className="inline-block size-3 shrink-0 rounded-full" style={{ background: "var(--viz-calc)" }} />;
  if (kind === "ring") return <span aria-hidden className="inline-block size-3 shrink-0 rounded-full border-2" style={{ borderColor: "var(--viz-calc)", background: "var(--surface)" }} />;
  const color = kind === "hatch-calc" ? "var(--viz-calc)" : kind === "hatch-review" ? "var(--viz-review)" : "var(--viz-pending)";
  return <span aria-hidden className={base} style={{ backgroundImage: `repeating-linear-gradient(45deg, ${color} 0 2px, transparent 2px 5px)`, border: `1px solid ${color}` }} />;
}

function Legend({ items }: { items: { swatch: Parameters<typeof Swatch>[0]["kind"]; label: string }[] }) {
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
      {items.map((i) => <li key={i.label} className="flex items-center gap-1.5"><Swatch kind={i.swatch} />{i.label}</li>)}
    </ul>
  );
}

function ChartCard({ title, subtitle, legend, children, table, id }: { title: string; subtitle?: string; legend?: React.ReactNode; children: React.ReactNode; table: React.ReactNode; id: string }) {
  const { t } = useI18n();
  return (
    <Card className="flex flex-col gap-3" aria-labelledby={`${id}-h`}>
      <div>
        <h2 id={`${id}-h`} className="text-lg font-semibold">{title}</h2>
        {subtitle && <p className="text-sm text-muted">{subtitle}</p>}
      </div>
      {legend}
      {children}
      <details className="text-sm">
        <summary className="flex min-h-11 cursor-pointer items-center font-medium text-action underline-offset-4 hover:underline dark:text-sage">{t("dash.chart.showTable")}</summary>
        <div tabIndex={0} className="overflow-x-auto">{table}</div>
      </details>
    </Card>
  );
}

/** Tooltip body: the value leads (strong), the label follows (secondary). */
function Tip({ children }: { children: React.ReactNode }) {
  return <div className="num min-w-44 max-w-64 rounded-xl border border-border bg-surface px-3 py-2.5 text-sm shadow-soft">{children}</div>;
}

const Empty = ({ text }: { text: string }) => <p className="grid h-48 place-items-center rounded-2xl bg-surface-soft px-4 text-center text-sm text-muted">{text}</p>;

/* ---------- daily bars ---------- */

export interface BarPoint {
  key: string; tick: string; title: string; amount: number | null; status: DayStatus;
  units: Record<string, string>; calculated: number; needsReview: number; pending: number; href: string | null;
}

/** Bars of Estimated Sales per day / week / month. A bucket with no figure is a short hatched stub, never a zero bar. */
export function SalesBarChart({ points, id, title, subtitle, ariaLabel }: { points: BarPoint[]; id: string; title: string; subtitle?: string; ariaLabel: string }) {
  const { t } = useI18n();
  const router = useRouter();
  const reduce = useReducedMotion();

  const withAmount = points.filter((p) => p.amount !== null);
  const max = Math.max(1, ...withAmount.map((p) => p.amount!));
  const stub = max * 0.07; // a short hatched stub marks buckets with no figure, so they are never mistaken for "zero sales"
  const data = points.map((p) => ({
    key: p.key, tick: p.tick, amount: p.amount ?? undefined,
    stub: p.amount === null && (p.status === "pending" || p.status === "review") ? stub : undefined, p,
  }));
  const best = withAmount.reduce<BarPoint | null>((b, p) => (b === null || p.amount! > b.amount! ? p : b), null);
  const total = withAmount.reduce((n, p) => n + p.amount!, 0);
  const go = (p: BarPoint) => { if (p.href) router.push(p.href); };

  return (
    <ChartCard
      id={id} title={title} subtitle={subtitle}
      legend={<Legend items={[
        { swatch: "solid", label: t("dash.chart.legend.calculated") }, { swatch: "hatch-calc", label: t("dash.chart.legend.partial") },
        { swatch: "hatch-review", label: t("dash.chart.legend.review") }, { swatch: "hatch-pending", label: t("dash.chart.legend.pending") },
      ]} />}
      table={
        <table className="num mt-2 w-full min-w-[26rem] text-left">
          <thead className="text-muted"><tr>{(["dash.chart.col.date", "dash.chart.col.amount", "dash.chart.col.units", "dash.chart.col.status"] as MessageKey[]).map((k) => <th key={k} scope="col" className="py-1.5 pr-3 font-medium">{t(k)}</th>)}<th className="sr-only">{t("dash.chart.open")}</th></tr></thead>
          <tbody>
            {points.filter((p) => p.status !== "none").map((p) => (
              <tr key={p.key} className="border-t border-border">
                <td className="py-1.5 pr-3">{p.title}</td>
                <td className="py-1.5 pr-3">{p.amount !== null ? formatLkr(p.amount) : "—"}</td>
                <td className="py-1.5 pr-3">{unitList(p.units).map((u) => `${u.qty} ${u.unit}`).join(" · ") || "—"}</td>
                <td className="py-1.5 pr-3">{t(statusKey[p.status])}</td>
                <td className="py-1.5">{p.href && <Link className="text-action underline-offset-4 hover:underline dark:text-sage" href={p.href}>{t("sh.col.date")}</Link>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      }
    >
      {withAmount.length === 0 && data.every((d) => d.stub === undefined) ? <Empty text={t("dash.chart.noData")} /> : (
        <>
          {best && <p className="num text-sm text-muted">{best.title}: <span className="font-semibold text-foreground">{formatLkr(best.amount)}</span> · Σ <span className="font-semibold text-foreground">{formatLkr(total)}</span></p>}
          <div role="img" aria-label={`${ariaLabel}. ${formatLkr(total)}`} className="h-64 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={data} margin={{ top: 8, right: 4, left: 0, bottom: 0 }} barCategoryGap="22%">
                <Patterns />
                <CartesianGrid vertical={false} stroke="var(--border)" strokeWidth={1} />
                <XAxis dataKey="tick" tickLine={false} axisLine={false} tick={tick} interval="preserveStartEnd" minTickGap={10} />
                <YAxis tickLine={false} axisLine={false} tick={tick} width={46} tickFormatter={axisMoney} />
                <Tooltip cursor={{ fill: "var(--surface-soft)" }} content={({ active, payload }) => {
                  const p = active ? (payload?.[0]?.payload as { p: BarPoint } | undefined)?.p : undefined;
                  if (!p) return null;
                  return (
                    <Tip>
                      <p className="text-base font-semibold">{p.amount !== null ? formatLkr(p.amount) : t(statusKey[p.status])}</p>
                      <p className="text-muted">{p.title}</p>
                      {p.amount !== null && <p className="mt-1 text-muted">{t(statusKey[p.status])}</p>}
                      {unitList(p.units).length > 0 && <p className="mt-1">{t("dash.chart.unitsSold")}: {unitList(p.units).map((u) => `${u.qty} ${u.unit}`).join(" · ")}</p>}
                      {(p.pending > 0 || p.needsReview > 0) && <p className="mt-1 text-muted">{t("dash.state.partial", { pending: p.pending, review: p.needsReview })}</p>}
                      {p.href && <p className="mt-1 text-xs text-muted">{t("dash.chart.openHint")}</p>}
                    </Tip>
                  );
                }} />
                <Bar dataKey="amount" stackId="s" maxBarSize={24} radius={[4, 4, 0, 0]} isAnimationActive={!reduce} animationDuration={500} cursor="pointer" onClick={(_, i) => go(data[i].p)}>
                  {data.map((d) => <Cell key={d.key} fill={d.p.status === "partial" ? "url(#hatch-calc)" : "var(--viz-calc)"} stroke={d.p.status === "partial" ? "var(--viz-calc)" : "none"} strokeWidth={1} />)}
                </Bar>
                <Bar dataKey="stub" stackId="s" maxBarSize={24} radius={[4, 4, 0, 0]} isAnimationActive={!reduce} cursor="pointer" onClick={(_, i) => go(data[i].p)}>
                  {data.map((d) => <Cell key={d.key} fill={d.p.status === "review" ? "url(#hatch-review)" : "url(#hatch-pending)"} stroke={d.p.status === "review" ? "var(--viz-review)" : "var(--viz-pending)"} strokeWidth={1} />)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </>
      )}
    </ChartCard>
  );
}

export function DailySalesChart({ points, month }: { points: DailyPoint[]; month: string }) {
  const { t, locale } = useI18n();
  const label = formatMonth(month, locale);
  const bars: BarPoint[] = points.map((p) => ({
    key: p.date, tick: String(p.day), title: formatBusinessDate(p.date, locale, { weekday: "short", day: "numeric", month: "short" }),
    amount: p.amount, status: p.status, units: p.units, calculated: p.calculated, needsReview: p.needsReview, pending: p.pending,
    href: p.detailSessionId ? `/stock-history/${p.detailSessionId}` : null,
  }));
  return <SalesBarChart id="daily" title={t("dash.chart.daily")} subtitle={label} ariaLabel={`${t("dash.chart.daily")}, ${label}`} points={bars} />;
}

/* ---------- monthly trend ---------- */

export function MonthlyTrendChart({ points }: { points: MonthPoint[] }) {
  const { t, locale } = useI18n();
  const reduce = useReducedMotion();
  // A month with nothing calculated is a gap in the line, not a zero.
  // Complete months form the line. A month that is still open (or waiting for its closing count) is plotted as a separate
  // hollow marker and is never joined to the line, so a part-month cannot read as a collapse in sales.
  const data = points.map((p) => ({
    label: formatMonth(p.month, locale, "short"), p,
    done: p.hasData && p.status === "complete" ? p.amount : null,
    open: p.hasData && p.status !== "complete" ? p.amount : null,
  }));
  const any = data.some((d) => d.done !== null || d.open !== null);

  return (
    <ChartCard
      id="trend" title={t("dash.chart.trend")} subtitle={t("dash.chart.trendSub")}
      legend={<Legend items={[{ swatch: "dot", label: t("dash.chart.legend.monthComplete") }, { swatch: "ring", label: t("dash.chart.legend.monthOpen") }]} />}
      table={
        <table className="num mt-2 w-full min-w-[26rem] text-left">
          <thead className="text-muted"><tr>{(["dash.chart.col.month", "dash.chart.col.amount", "dash.chart.col.units", "dash.chart.col.status"] as MessageKey[]).map((k) => <th key={k} scope="col" className="py-1.5 pr-3 font-medium">{t(k)}</th>)}</tr></thead>
          <tbody>
            {points.map((p) => (
              <tr key={p.month} className="border-t border-border">
                <td className="py-1.5 pr-3">{formatMonth(p.month, locale, "short")}</td>
                <td className="py-1.5 pr-3">{p.hasData ? formatLkr(p.amount) : "—"}</td>
                <td className="py-1.5 pr-3">{unitList(p.units).map((u) => `${u.qty} ${u.unit}`).join(" · ") || "—"}</td>
                <td className="py-1.5">{p.status === "complete" ? t("dash.month.complete") : p.status === "in_progress" ? t("dash.month.inProgress") : t("dash.month.pending", { date: p.waitingFor ?? "" })}</td>
              </tr>
            ))}
          </tbody>
        </table>
      }
    >
      {!any ? <Empty text={t("dash.chart.noData")} /> : (
        <div role="img" aria-label={`${t("dash.chart.trend")}, ${t("dash.chart.trendSub")}`} className="h-64 w-full">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={data} margin={{ top: 12, right: 12, left: 0, bottom: 0 }}>
              <CartesianGrid vertical={false} stroke="var(--border)" strokeWidth={1} />
              <XAxis dataKey="label" tickLine={false} axisLine={false} tick={tick} interval="preserveStartEnd" minTickGap={14} />
              <YAxis tickLine={false} axisLine={false} tick={tick} width={46} tickFormatter={axisMoney} />
              <Tooltip cursor={{ stroke: "var(--border)", strokeWidth: 1 }} content={({ active, payload }) => {
                const p = active ? (payload?.[0]?.payload as { p: MonthPoint } | undefined)?.p : undefined;
                if (!p) return null;
                return (
                  <Tip>
                    <p className="text-base font-semibold">{p.hasData ? formatLkr(p.amount) : t("dash.chart.noBar")}</p>
                    <p className="text-muted">{formatMonth(p.month, locale)}</p>
                    {unitList(p.units).length > 0 && <p className="mt-1">{t("dash.chart.unitsSold")}: {unitList(p.units).map((u) => `${u.qty} ${u.unit}`).join(" · ")}</p>}
                    <p className="mt-1 text-muted">{p.status === "complete" ? t("dash.month.complete") : p.status === "in_progress" ? t("dash.month.inProgress") : t("dash.month.pending", { date: p.waitingFor ?? "" })}</p>
                  </Tip>
                );
              }} />
              <Line type="monotone" dataKey="done" stroke="var(--viz-calc)" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" connectNulls={false}
                isAnimationActive={!reduce} animationDuration={600}
                dot={(props: { cx?: number; cy?: number; index?: number; value?: number | null }) => {
                  const { cx, cy, index, value } = props;
                  if (cx === undefined || cy === undefined || value === null || value === undefined) return <g key={index} />;
                  // 8px dot with a 2px surface ring so it stays legible where it crosses the line
                  return <circle key={index} cx={cx} cy={cy} r={4} strokeWidth={2} style={{ fill: "var(--viz-calc)", stroke: "var(--surface)" }} />;
                }}
                activeDot={{ r: 6, strokeWidth: 2, style: { fill: "var(--viz-calc)", stroke: "var(--surface)" } }} />
              <Line dataKey="open" stroke="none" connectNulls={false} isAnimationActive={false} legendType="none"
                dot={(props: { cx?: number; cy?: number; index?: number; value?: number | null }) => {
                  const { cx, cy, index, value } = props;
                  if (cx === undefined || cy === undefined || value === null || value === undefined) return <g key={index} />;
                  return <circle key={index} cx={cx} cy={cy} r={4.5} strokeWidth={2} style={{ fill: "var(--surface)", stroke: "var(--viz-calc)" }} />;
                }}
                activeDot={{ r: 6, strokeWidth: 2, style: { fill: "var(--surface)", stroke: "var(--viz-calc)" } }} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}
    </ChartCard>
  );
}

/* ---------- ranked horizontal bars (products, categories): one hue, value at the tip ---------- */

export interface RankedItem { id: string; name: string; amount: number; unitsText: string; sub?: string }

export function RankedBarsChart({ id, title, subtitle, items, valueHeader, nameHeader }: { id: string; title: string; subtitle?: string; items: RankedItem[]; valueHeader: string; nameHeader: string }) {
  const { t } = useI18n();
  const reduce = useReducedMotion();
  const trunc = (s: string) => (s.length > 24 ? `${s.slice(0, 23)}…` : s);

  return (
    <ChartCard
      id={id} title={title} subtitle={subtitle}
      table={
        <table className="num mt-2 w-full min-w-[22rem] text-left">
          <thead className="text-muted"><tr><th scope="col" className="py-1.5 pr-3 font-medium">{nameHeader}</th><th scope="col" className="py-1.5 pr-3 font-medium">{valueHeader}</th><th scope="col" className="py-1.5 font-medium">{t("dash.chart.col.units")}</th></tr></thead>
          <tbody>{items.map((i) => <tr key={i.id} className="border-t border-border"><td className="py-1.5 pr-3">{i.name}{i.sub ? ` · ${i.sub}` : ""}</td><td className="py-1.5 pr-3">{formatLkr(i.amount)}</td><td className="py-1.5">{i.unitsText || "—"}</td></tr>)}</tbody>
        </table>
      }
    >
      {items.length === 0 ? <Empty text={t("dash.chart.noData")} /> : (
        <div role="img" aria-label={title} style={{ height: items.length * 44 + 16 }} className="w-full">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={items} layout="vertical" margin={{ top: 0, right: 96, left: 0, bottom: 0 }} barCategoryGap="30%">
              <XAxis type="number" hide domain={[0, "dataMax"]} />
              <YAxis type="category" dataKey="name" tickLine={false} axisLine={false} width={156}
                tick={({ x, y, payload }: { x?: number | string; y?: number | string; payload?: { value?: string | number } }) => (
                  <text x={Number(x) - 4} y={y} dy={4} textAnchor="end" style={{ fill: "var(--foreground)", fontSize: 12 }}>{trunc(String(payload?.value ?? ""))}</text>
                )} />
              <Tooltip cursor={{ fill: "var(--surface-soft)" }} content={({ active, payload }) => {
                const i = active ? (payload?.[0]?.payload as RankedItem | undefined) : undefined;
                if (!i) return null;
                return <Tip><p className="text-base font-semibold">{formatLkr(i.amount)}</p><p className="text-muted">{i.name}{i.sub ? ` · ${i.sub}` : ""}</p>{i.unitsText && <p className="mt-1">{t("dash.chart.unitsSold")}: {i.unitsText}</p>}</Tip>;
              }} />
              <Bar dataKey="amount" fill="var(--viz-calc)" maxBarSize={20} radius={[0, 4, 4, 0]} isAnimationActive={!reduce} animationDuration={500}>
                <LabelList dataKey="amount" position="right" formatter={(v: unknown) => `Rs. ${Math.round(Number(v)).toLocaleString("en-US")}`} style={{ fill: "var(--foreground)", fontSize: 12, fontVariantNumeric: "tabular-nums" }} />
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
    </ChartCard>
  );
}

export function TopProductsChart({ items, month }: { items: TopProduct[]; month: string }) {
  const { t, locale } = useI18n();
  return (
    <RankedBarsChart id="top" title={t("dash.chart.top")} subtitle={t("dash.chart.topSub", { month: formatMonth(month, locale) })}
      nameHeader={t("dash.chart.col.product")} valueHeader={t("dash.chart.col.amount")}
      items={items.map((i) => ({ id: i.variantId, name: `${i.name} ${i.size}`.trim(), amount: Number(i.amount), unitsText: `${i.units} ${i.baseUnit}` }))} />
  );
}

/* ---------- stock movement trend: inflow above the baseline, outflow below ---------- */

export interface MovementPoint { key: string; title: string; inflow: number; outflow: number; received: number; returned: number; damaged: number; otherOut: number; adjustments: number }

export function MovementTrendChart({ points, unit }: { points: MovementPoint[]; unit: string }) {
  const { t } = useI18n();
  const reduce = useReducedMotion();
  const data = points.map((p) => ({ key: p.key, tick: p.key.slice(5), inflow: p.inflow, outflow: -p.outflow, p }));
  const any = points.some((p) => p.inflow !== 0 || p.outflow !== 0);
  const fmt = (n: number) => `${n.toLocaleString("en-US", { maximumFractionDigits: 3 })} ${unit}`;
  const key = (c: string) => <span aria-hidden className="mr-1.5 inline-block h-0.5 w-3 align-middle" style={{ background: c }} />;

  return (
    <ChartCard
      id="mov" title={t("an.movementTitle", { unit })} subtitle={t("an.movementSub")}
      legend={<ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted"><li className="flex items-center gap-1.5"><span aria-hidden className="inline-block size-3 rounded-[3px]" style={{ background: "var(--viz-calc)" }} />{t("an.movementIn")}</li><li className="flex items-center gap-1.5"><span aria-hidden className="inline-block size-3 rounded-[3px]" style={{ background: "var(--viz-review)" }} />{t("an.movementOut")}</li></ul>}
      table={
        <table className="num mt-2 w-full min-w-[30rem] text-left">
          <thead className="text-muted"><tr>{(["an.col.period", "an.movementIn", "an.movementOut", "an.col.net"] as MessageKey[]).map((k) => <th key={k} scope="col" className="py-1.5 pr-3 font-medium">{t(k)}</th>)}</tr></thead>
          <tbody>{points.filter((p) => p.inflow !== 0 || p.outflow !== 0).map((p) => <tr key={p.key} className="border-t border-border"><td className="py-1.5 pr-3">{p.title}</td><td className="py-1.5 pr-3">{fmt(p.inflow)}</td><td className="py-1.5 pr-3">{fmt(p.outflow)}</td><td className="py-1.5">{fmt(p.inflow - p.outflow)}</td></tr>)}</tbody>
        </table>
      }
    >
      {!any ? <Empty text={t("an.movementNone")} /> : (
        <div role="img" aria-label={t("an.movementTitle", { unit })} className="h-64 w-full">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={data} stackOffset="sign" margin={{ top: 8, right: 4, left: 0, bottom: 0 }} barCategoryGap="22%">
              <CartesianGrid vertical={false} stroke="var(--border)" strokeWidth={1} />
              <XAxis dataKey="tick" tickLine={false} axisLine={false} tick={tick} interval="preserveStartEnd" minTickGap={10} />
              <YAxis tickLine={false} axisLine={false} tick={tick} width={46} tickFormatter={(v: number) => (v < 0 ? `−${axisMoney(-v)}` : axisMoney(v))} />
              <ReferenceLine y={0} stroke="var(--muted)" strokeWidth={1} />
              <Tooltip cursor={{ fill: "var(--surface-soft)" }} content={({ active, payload }) => {
                const p = active ? (payload?.[0]?.payload as { p: MovementPoint } | undefined)?.p : undefined;
                if (!p) return null;
                return (
                  <Tip>
                    <p className="text-muted">{p.title}</p>
                    <p className="mt-1">{key("var(--viz-calc)")}<span className="font-semibold">{fmt(p.inflow)}</span> <span className="text-muted">{t("an.movementIn")}</span></p>
                    <p>{key("var(--viz-review)")}<span className="font-semibold">{fmt(p.outflow)}</span> <span className="text-muted">{t("an.movementOut")}</span></p>
                    <p className="mt-1 text-xs text-muted">{[p.received && `${t("mv.type.stock_received")} ${p.received}`, p.returned && `${t("mv.type.customer_return")} ${p.returned}`, p.damaged && `${t("mv.type.damaged")} ${p.damaged}`, p.otherOut && `${t("mv.type.supplier_return")} ${p.otherOut}`, p.adjustments && `${t("mv.type.manual_adjustment")} ${p.adjustments > 0 ? "+" : ""}${p.adjustments}`].filter(Boolean).join(" · ")}</p>
                  </Tip>
                );
              }} />
              <Bar dataKey="inflow" stackId="m" fill="var(--viz-calc)" maxBarSize={24} radius={[4, 4, 0, 0]} isAnimationActive={!reduce} animationDuration={500} />
              <Bar dataKey="outflow" stackId="m" fill="var(--viz-review)" maxBarSize={24} radius={[0, 0, 4, 4]} isAnimationActive={!reduce} animationDuration={500} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
    </ChartCard>
  );
}
