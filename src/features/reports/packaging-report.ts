import Decimal from "decimal.js";

/**
 * The packaging side of the monthly report (pure). It splits the month's Estimated Sales by HOW CERTAIN the packaging mix is,
 * and never blends the groups into one unlabelled figure:
 *
 *   known     a packaging breakdown was recorded: the revenue uses the package prices of each day
 *   unknown   the product CAN be sold in packages but no breakdown was recorded: an estimate at the single-unit price
 *   standard  the product has no sellable packaging: the ordinary estimate (inferred units x price)
 *
 * The three amounts always add up to the report's Estimated Sales. Quantities are only added within one base unit.
 */
export type PackagingBucket = "known" | "unknown" | "standard";

/** One row of `monthly_packaging_report`: one product on one calculated day. */
export interface PackagingRow {
  sales_date: string; variant_id: string; product_name: string; sku: string; base_unit: string;
  units_sold: string | null; estimated_amount: string | null;
  bucket: PackagingBucket; packaging_status: "unknown" | "known" | "stale";
  lines: { name: string; is_base_unit: boolean; quantity: number | string; base_units: number | string; unit_price: number | string; amount: number | string }[] | null;
}

export interface BucketTotal {
  /** Estimated Sales of this group, LKR. */
  amount: string;
  /** Product-days in this group. */
  productDays: number;
  /** Units sold, per base unit (never added across units). */
  units: Record<string, string>;
}

export interface KnownProduct {
  name: string; sku: string; unit: string; days: number; unitsSold: string; amount: string;
  /** What was sold, summed over the days: boxes, then single units. */
  packages: { name: string; isBaseUnit: boolean; quantity: string; amount: string }[];
}

export interface PackagingReport {
  known: BucketTotal; unknown: BucketTotal; standard: BucketTotal;
  /** known + unknown + standard: equals the report's Estimated Sales. */
  total: string;
  /** Days with a breakdown that no longer fits (kept for review, valued as unknown). */
  staleDays: number;
  /** Per product, for the known breakdowns only. */
  knownProducts: KnownProduct[];
  /** Only the days that have a known breakdown, with that day's known and estimated amounts side by side. */
  daily: { date: string; known: string; estimated: string }[];
}

const D = (v: Decimal.Value | null | undefined) => new Decimal(v ?? 0);
const unitKey = (u: string) => u.toLowerCase();

export function emptyPackagingReport(): PackagingReport {
  const b = (): BucketTotal => ({ amount: "0.00", productDays: 0, units: {} });
  return { known: b(), unknown: b(), standard: b(), total: "0.00", staleDays: 0, knownProducts: [], daily: [] };
}

export function buildPackagingReport(rows: PackagingRow[]): PackagingReport {
  const acc: Record<PackagingBucket, { amount: Decimal; days: number; units: Record<string, Decimal> }> = {
    known: { amount: D(0), days: 0, units: {} }, unknown: { amount: D(0), days: 0, units: {} }, standard: { amount: D(0), days: 0, units: {} },
  };
  const products = new Map<string, { name: string; sku: string; unit: string; days: number; units: Decimal; amount: Decimal; pk: Map<string, { name: string; isBase: boolean; qty: Decimal; amount: Decimal }> }>();
  const days = new Map<string, { known: Decimal; estimated: Decimal }>();
  let stale = 0;

  for (const r of rows) {
    const a = acc[r.bucket];
    const amount = D(r.estimated_amount);
    a.amount = a.amount.plus(amount);
    a.days++;
    const u = unitKey(r.base_unit);
    a.units[u] = (a.units[u] ?? D(0)).plus(D(r.units_sold));
    if (r.packaging_status === "stale") stale++;

    const day = days.get(r.sales_date) ?? { known: D(0), estimated: D(0) };
    if (r.bucket === "known") day.known = day.known.plus(amount); else day.estimated = day.estimated.plus(amount);
    days.set(r.sales_date, day);

    if (r.bucket === "known") {
      const p = products.get(r.variant_id) ?? { name: r.product_name, sku: r.sku, unit: u, days: 0, units: D(0), amount: D(0), pk: new Map() };
      p.days++; p.units = p.units.plus(D(r.units_sold)); p.amount = p.amount.plus(amount);
      for (const l of r.lines ?? []) {
        const k = `${l.is_base_unit ? "~" : ""}${l.name}`;
        const e = p.pk.get(k) ?? { name: l.name, isBase: l.is_base_unit, qty: D(0), amount: D(0) };
        e.qty = e.qty.plus(D(l.quantity)); e.amount = e.amount.plus(D(l.amount));
        p.pk.set(k, e);
      }
      products.set(r.variant_id, p);
    }
  }

  const fin = (b: (typeof acc)[PackagingBucket]): BucketTotal => ({
    amount: b.amount.toFixed(2), productDays: b.days, units: Object.fromEntries(Object.entries(b.units).map(([k, v]) => [k, v.toString()])),
  });
  // a day is listed when ANY product that day had a known breakdown (even a known day worth Rs. 0.00)
  const knownDates = new Set(rows.filter((r) => r.bucket === "known").map((r) => r.sales_date));
  const daily = [...days.entries()].filter(([d]) => knownDates.has(d)).sort(([a], [b]) => a.localeCompare(b))
    .map(([date, v]) => ({ date, known: v.known.toFixed(2), estimated: v.estimated.toFixed(2) }));

  return {
    known: fin(acc.known), unknown: fin(acc.unknown), standard: fin(acc.standard),
    total: acc.known.amount.plus(acc.unknown.amount).plus(acc.standard.amount).toFixed(2),
    staleDays: stale,
    knownProducts: [...products.values()].sort((a, b) => b.amount.comparedTo(a.amount) || a.name.localeCompare(b.name)).map((p) => ({
      name: p.name, sku: p.sku, unit: p.unit, days: p.days, unitsSold: p.units.toString(), amount: p.amount.toFixed(2),
      packages: [...p.pk.values()].sort((a, b) => Number(a.isBase) - Number(b.isBase) || b.qty.comparedTo(a.qty)).map((e) => ({ name: e.name, isBaseUnit: e.isBase, quantity: e.qty.toString(), amount: e.amount.toFixed(2) })),
    })),
    daily,
  };
}
