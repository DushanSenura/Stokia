import type { Metadata } from "next";
import { ArrowLeftRight, PackagePlus } from "lucide-react";
import { ReverseForm } from "@/components/movements/movement-forms";
import { Button, ButtonLink } from "@/components/ui/button";
import { Badge, EmptyState } from "@/components/ui/feedback";
import { Card } from "@/components/ui/card";
import { Input, Label, Select } from "@/components/ui/input";
import { getTranslator } from "@/i18n/server";
import { addDays, dayStartInstant, isBusinessDate } from "@/lib/dates/business";
import { formatShopDateTime } from "@/lib/dates/format";
import { createClient } from "@/lib/supabase/server";
import { MOVEMENT_TYPES, type MovementType } from "@/lib/calculations/reconcile";
import { listMovements, MOVEMENTS_PAGE_SIZE, variantLabel } from "@/server/repositories/movements";
import { getSessionContext } from "@/server/services/session";
import type { MessageKey } from "@/i18n";
import { can } from "@/server/permissions";

export const metadata: Metadata = { title: "Stock Movements" };
const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
const tone: Record<MovementType, "success" | "danger" | "warning" | "info" | "neutral"> = {
  stock_received: "success", customer_return: "success", supplier_return: "warning", damaged: "danger",
  expired: "danger", discarded: "danger", manual_adjustment: "info", repacking: "neutral",
};

export default async function MovementsPage({ searchParams }: PageProps<"/movements">) {
  const { t } = await getTranslator();
  const sp = await searchParams;
  const m = (await getSessionContext()).membership!;
  const canRecord = can(m.role, "inventory.write");

  const from = isBusinessDate(first(sp.from)) ? first(sp.from) : undefined;
  const to = isBusinessDate(first(sp.to)) ? first(sp.to) : undefined;
  const type = MOVEMENT_TYPES.find((x) => x === first(sp.type));
  const page = Math.max(1, Number(first(sp.page)) || 1);

  const { rows, total, error, reversed, people } = await listMovements(await createClient(), {
    type, page,
    from: from ? dayStartInstant(from, m.timezone) : undefined,
    to: to ? dayStartInstant(addDays(to, 1), m.timezone) : undefined,
  });
  const pages = Math.max(1, Math.ceil(total / MOVEMENTS_PAGE_SIZE));
  const qs = (p: number) => { const u = new URLSearchParams({ ...(from ? { from } : {}), ...(to ? { to } : {}), ...(type ? { type } : {}), ...(p > 1 ? { page: String(p) } : {}) }); return u.toString() ? `?${u}` : ""; };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="max-w-2xl">
          <h1 className="text-[28px] font-semibold tracking-tight">{t("mv.title")}</h1>
          <p className="text-muted">{t("mv.subtitle")}</p>
        </div>
        {canRecord && (
          <div className="flex flex-wrap gap-2">
            <ButtonLink href="/movements/repack" variant="secondary"><ArrowLeftRight className="size-4" aria-hidden />{t("mv.repack")}</ButtonLink>
            <ButtonLink href="/movements/new"><PackagePlus className="size-4" aria-hidden />{t("mv.record")}</ButtonLink>
          </div>
        )}
      </div>

      <Card>
        <form method="get" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-[1fr_1fr_1fr_auto] lg:items-end">
          <div><Label htmlFor="from">{t("sh.from")}</Label><Input id="from" name="from" type="date" defaultValue={from} /></div>
          <div><Label htmlFor="to">{t("sh.to")}</Label><Input id="to" name="to" type="date" defaultValue={to} /></div>
          <div>
            <Label htmlFor="type">{t("mv.filter.type")}</Label>
            <Select id="type" name="type" defaultValue={type ?? ""}>
              <option value="">{t("mv.filter.all")}</option>
              {MOVEMENT_TYPES.map((x) => <option key={x} value={x}>{t(`mv.type.${x}` as MessageKey)}</option>)}
            </Select>
          </div>
          <Button type="submit">{t("mv.filter.apply")}</Button>
        </form>
      </Card>

      {error ? (
        <EmptyState title={t("error.title")} body={t("error.body")} />
      ) : rows.length === 0 ? (
        <EmptyState icon={<ArrowLeftRight className="size-6" aria-hidden />} title={t("mv.empty")} action={canRecord ? <ButtonLink href="/movements/new">{t("mv.record")}</ButtonLink> : undefined} />
      ) : (
        <>
          <p className="text-sm text-muted" aria-live="polite">{t("common.results", { count: total })}</p>
          <div tabIndex={0} className="overflow-x-auto rounded-[var(--radius-card)] border border-border bg-surface shadow-soft">
            <table className="w-full min-w-[56rem] text-left text-sm">
              <thead className="border-b border-border text-muted">
                <tr>{(["mv.col.when", "mv.col.type", "mv.col.product", "mv.col.quantity", "mv.col.effect", "mv.col.note", "mv.col.by"] as MessageKey[]).map((k) => <th key={k} scope="col" className="px-4 py-3 font-medium">{t(k)}</th>)}<th scope="col" className="px-4 py-3"><span className="sr-only">{t("common.actions")}</span></th></tr>
              </thead>
              <tbody className="num">
                {rows.map((r) => {
                  const eff = Number(r.normalized_base_quantity);
                  const isReversal = r.reversed_movement_id !== null;
                  return (
                    <tr key={r.id} className={`border-t border-border align-top ${reversed.has(r.id) ? "opacity-60" : ""}`}>
                      <td className="px-4 py-3 whitespace-nowrap">{formatShopDateTime(r.effective_at, m.timezone)}</td>
                      <td className="px-4 py-3">
                        <Badge tone={tone[r.type]}>{t(`mv.type.${r.type}` as MessageKey)}</Badge>
                        {reversed.has(r.id) && <Badge className="ml-1">{t("mv.badge.reversed")}</Badge>}
                        {isReversal && <Badge className="ml-1">{t("mv.badge.reversal")}</Badge>}
                      </td>
                      <td className="px-4 py-3">{variantLabel(r.product_variants)}<br /><span className="text-muted">{r.product_variants?.sku}</span></td>
                      <td className="px-4 py-3">{Number(r.input_quantity)} {r.packaging_units?.name ?? r.product_variants?.base_inventory_unit}</td>
                      <td className={`px-4 py-3 font-semibold ${eff > 0 ? "text-success" : "text-danger"}`}>{eff > 0 ? "+" : ""}{eff} {r.product_variants?.base_inventory_unit}</td>
                      <td className="px-4 py-3 max-w-64 break-words">{[r.reason, r.reference, r.supplier].filter(Boolean).join(" · ") || "—"}</td>
                      <td className="px-4 py-3">{people.get(r.created_by) ?? "—"}</td>
                      <td className="px-4 py-3">{canRecord && !isReversal && !reversed.has(r.id) && <ReverseForm movementId={r.id} />}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {pages > 1 && (
            <nav aria-label="Pagination" className="flex items-center justify-between gap-3">
              {page > 1 ? <ButtonLink href={`/movements${qs(page - 1)}`} variant="secondary">{t("common.previous")}</ButtonLink> : <span />}
              <span className="num text-sm text-muted">{t("common.pageOf", { page, pages })}</span>
              {page < pages ? <ButtonLink href={`/movements${qs(page + 1)}`} variant="secondary">{t("common.next")}</ButtonLink> : <span />}
            </nav>
          )}
        </>
      )}
    </div>
  );
}
