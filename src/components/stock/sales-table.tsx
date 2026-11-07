import { Alert, Badge } from "@/components/ui/feedback";
import { formatLkr } from "@/lib/formatting/money";
import { sizeLabel } from "@/lib/formatting/units";
import type { SalesRow } from "@/server/repositories/inventory";
import type { MessageKey, Translator } from "@/i18n";

const tone = { calculated: "success", recalculated: "info", needs_review: "warning", pending: "neutral" } as const;
const n = (v: number | string | null | undefined) => (v === null || v === undefined ? "—" : String(Number(v)));

/**
 * Per-product explanation of a day's sales: every number that went into the figure is shown, and anything that
 * could not be worked out says why (pending / needs review) instead of showing a made-up number.
 */
export function SalesTable({ rows, t }: { rows: SalesRow[]; t: Translator }) {
  if (rows.length === 0) return <Alert tone="info">{t("sales.none")}</Alert>;
  const heads: MessageKey[] = ["sales.col.product", "sales.col.opening", "sales.col.received", "sales.col.returns", "sales.col.damaged", "sales.col.adjust", "sales.col.closing", "sales.col.sold", "sales.col.value", "sales.col.status"];
  return (
    <div tabIndex={0} className="overflow-x-auto rounded-[var(--radius-card)] border border-border bg-surface shadow-soft">
      <table className="w-full min-w-[60rem] text-left text-sm">
        <thead className="border-b border-border text-muted">
          <tr>{heads.map((k) => <th key={k} scope="col" className="px-3 py-3 font-medium">{t(k)}</th>)}</tr>
        </thead>
        <tbody className="num">
          {rows.map((r) => {
            const b = r.breakdown;
            const v = r.product_variants;
            const dmg = b ? Number(b.damaged) + Number(b.other_out) : null;
            return (
              <tr key={r.variant_id} className="border-t border-border align-top">
                <td className="px-3 py-3"><span className="font-medium">{v?.products?.name}</span> <span className="text-muted">{sizeLabel(v?.size_value ?? null, v?.size_unit ?? null)} · {v?.sku}</span></td>
                <td className="px-3 py-3">{b ? n(b.opening) : "—"}</td>
                <td className="px-3 py-3">{b && Number(b.received) ? `+${n(b.received)}` : b ? "0" : "—"}</td>
                <td className="px-3 py-3">{b && Number(b.returns) ? `+${n(b.returns)}` : b ? "0" : "—"}</td>
                <td className="px-3 py-3">{dmg ? `−${dmg}` : b ? "0" : "—"}</td>
                <td className="px-3 py-3">{b && Number(b.adjustments) ? `${Number(b.adjustments) > 0 ? "+" : ""}${n(b.adjustments)}` : b ? "0" : "—"}</td>
                <td className="px-3 py-3">{b ? n(b.closing) : "—"}</td>
                <td className="px-3 py-3 font-semibold">{r.inferred_base_units_sold !== null ? `${n(r.inferred_base_units_sold)} ${v?.base_inventory_unit ?? ""}` : "—"}</td>
                <td className="px-3 py-3 font-semibold">
                  {r.estimated_sales_amount !== null ? formatLkr(r.estimated_sales_amount)
                    : r.calculation_status === "calculated" || r.calculation_status === "recalculated" ? <span className="font-normal text-muted">{t("sales.noPrice")}</span> : "—"}
                  {r.packaging_status === "known" && <Badge tone="success" className="mt-1 block w-fit font-normal">{t("sb.status.known")}</Badge>}
                  {r.packaging_status === "stale" && <Badge tone="warning" className="mt-1 block w-fit font-normal">{t("sb.status.stale")}</Badge>}
                </td>
                <td className="px-3 py-3">
                  <Badge tone={tone[r.calculation_status]}>{t(`sales.status.${r.calculation_status}` as MessageKey)}</Badge>
                  {r.calculation_revision > 1 && <span className="ml-1 text-xs text-muted">{t("sales.revision", { n: r.calculation_revision })}</span>}
                  {r.pending_reason && <p className={`mt-1 max-w-56 text-xs ${r.calculation_status === "needs_review" ? "text-warning" : "text-muted"}`}>{t(`sales.reason.${r.pending_reason}` as MessageKey)}</p>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
