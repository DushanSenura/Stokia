import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ConversionPreview } from "@/components/packaging/conversion-preview";
import { PackagingUnitForm, UnitActiveButton } from "@/components/packaging/packaging-forms";
import { BaseUnitSellableForm, PackagingPriceForm, PackagingUseForm } from "@/components/packaging/packaging-sales-forms";
import { ButtonLink } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Alert, Badge } from "@/components/ui/feedback";
import { getTranslator } from "@/i18n/server";
import { describeUnit } from "@/lib/calculations/packaging";
import { sizeLabel } from "@/lib/formatting/units";
import { formatBusinessDate } from "@/lib/dates/business";
import { formatShopDateTime, shopLocalDate } from "@/lib/dates/format";
import { formatLkr } from "@/lib/formatting/money";
import { getVariantPackaging, toPackUnit } from "@/server/repositories/packaging";
import { getSessionContext } from "@/server/services/session";
import { can } from "@/server/permissions";

export const metadata: Metadata = { title: "Packaging setup" };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function VariantPackagingPage({ params }: PageProps<"/packaging/[variantId]">) {
  const { variantId } = await params;
  if (!UUID.test(variantId)) notFound();
  const { t, locale } = await getTranslator();
  const ctx = await getSessionContext();
  const canEdit = can(ctx.membership?.role, "catalog.write");

  const data = await getVariantPackaging(variantId);
  if (!data) notFound();
  const { variant, units, lockedUnitIds, prices, basePrice } = data;
  const tz = ctx.membership?.timezone ?? "Asia/Colombo";
  const dateOf = (iso: string) => formatBusinessDate(shopLocalDate(iso, tz), locale);
  const base = variant.base_inventory_unit;
  const packUnits = units.map(toPackUnit);
  const activeUnits = packUnits.filter((u) => u.isActive !== false);

  return (
    <div className="max-w-4xl space-y-8">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-[28px] font-semibold tracking-tight">
            {variant.products?.name} <span className="font-normal text-muted">{sizeLabel(variant.size_value, variant.size_unit)}</span>
          </h1>
          <p className="num text-muted">{variant.sku} · {t("pk.countedIn")} {base}</p>
        </div>
        <ButtonLink href="/packaging" variant="ghost">{t("pk.back")}</ButtonLink>
      </div>

      <div className="space-y-2">
        <Alert tone="info">{t("pk.note.separate")}</Alert>
        <Alert tone="warning">{t("pk.note.kits")}</Alert>
      </div>

      <Card className="space-y-2">
        <p className="text-lg font-semibold">{t("pk.base.title", { unit: base })}</p>
        <p className="num text-muted">
          {basePrice ? t("pk.base.price", { unit: base, amount: formatLkr(basePrice.amount_lkr) }) : t("pk.base.noPrice", { unit: base })}
        </p>
        {canEdit
          ? <BaseUnitSellableForm variantId={variant.id} sellable={variant.base_unit_sellable} />
          : <Badge tone={variant.base_unit_sellable ? "success" : "neutral"}>{variant.base_unit_sellable ? t("pk.use.stockAndSales") : t("pk.use.stockOnly")}</Badge>}
      </Card>

      <section aria-labelledby="units-h" className="space-y-4">
        <h2 id="units-h" className="text-xl font-semibold">{t("pk.units")}</h2>
        {units.length === 0 && <Alert tone="info">{t("pk.unitsNone", { unit: base })}</Alert>}

        {units.map((u) => {
          const pu = toPackUnit(u);
          const locked = lockedUnitIds.has(u.id);
          const sold = u.can_be_sold === true;
          const counted = u.can_be_counted !== false;
          const unitPrices = prices.filter((p) => p.unit_id === u.id);
          const current = unitPrices.find((p) => p.effective_to === null);
          const options = activeUnits.filter((o) => o.id !== u.id).map((o) => ({ id: o.id, name: o.name }));
          return (
            <Card key={u.id} className={u.is_active ? "space-y-3" : "space-y-3 opacity-70"}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-lg font-semibold">{u.name}</p>
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={sold ? "success" : "neutral"}>{sold ? (counted ? t("pk.use.stockAndSales") : t("pk.use.salesOnly")) : t("pk.use.stockOnly")}</Badge>
                  {!u.is_active && <Badge>{t("pk.inactive")}</Badge>}
                </div>
              </div>
              <p className="num text-muted">{u.is_active ? describeUnit(pu, activeUnits, base) : `${Number(u.base_unit_multiplier)} ${base}`}</p>
              {sold && (
                <div className="space-y-1">
                  <p className="num font-medium">
                    {current ? t("pk.price.current", { amount: formatLkr(current.amount_lkr), date: dateOf(current.effective_from) }) : t("pk.price.none")}
                  </p>
                  {unitPrices.length > 1 && (
                    <details className="text-sm text-muted">
                      <summary className="flex min-h-11 cursor-pointer items-center">{t("pk.price.history")}</summary>
                      <ul className="num space-y-1 pb-2">
                        {unitPrices.map((p) => (
                          <li key={p.id}>
                            {formatLkr(p.amount_lkr)} · {p.effective_to ? t("pk.price.until", { from: formatShopDateTime(p.effective_from, tz), to: formatShopDateTime(p.effective_to, tz) }) : t("pk.price.fromNow", { from: formatShopDateTime(p.effective_from, tz) })}
                          </li>
                        ))}
                      </ul>
                    </details>
                  )}
                </div>
              )}
              {canEdit && (
                <>
                  <details className="rounded-xl border border-border p-4">
                    <summary className="flex min-h-11 cursor-pointer items-center font-medium">{t("pk.use.title")}</summary>
                    <div className="mt-3 space-y-5">
                      <PackagingUseForm variantId={variant.id} unitId={u.id} canBeSold={sold} canBeCounted={counted} />
                      {sold ? <PackagingPriceForm variantId={variant.id} unitId={u.id} /> : <p className="text-sm text-muted">{t("pk.price.needsSold")}</p>}
                    </div>
                  </details>
                  <details className="rounded-xl border border-border p-4">
                    <summary className="flex min-h-11 cursor-pointer items-center font-medium">{t("common.edit")}</summary>
                    <div className="mt-3">
                      <PackagingUnitForm variantId={variant.id} baseUnit={base} options={options} locked={locked}
                        unit={{ id: u.id, name: u.name, parent_unit_id: u.parent_unit_id, conversion_factor: u.conversion_factor }} />
                    </div>
                  </details>
                  <UnitActiveButton variantId={variant.id} unitId={u.id} active={u.is_active} />
                </>
              )}
            </Card>
          );
        })}

        {canEdit && (
          <Card>
            <h3 className="mb-4 font-semibold">{t("pk.add")}</h3>
            <PackagingUnitForm variantId={variant.id} baseUnit={base} options={activeUnits.map((o) => ({ id: o.id, name: o.name }))} />
          </Card>
        )}
      </section>

      <ConversionPreview units={packUnits} baseUnit={base} />
    </div>
  );
}
