import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ConversionPreview } from "@/components/packaging/conversion-preview";
import { PackagingUnitForm, UnitActiveButton } from "@/components/packaging/packaging-forms";
import { ButtonLink } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Alert, Badge } from "@/components/ui/feedback";
import { getTranslator } from "@/i18n/server";
import { describeUnit } from "@/lib/calculations/packaging";
import { sizeLabel } from "@/lib/formatting/units";
import { getVariantPackaging, toPackUnit } from "@/server/repositories/packaging";
import { getSessionContext } from "@/server/services/session";
import { can } from "@/server/permissions";

export const metadata: Metadata = { title: "Packaging setup" };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function VariantPackagingPage({ params }: PageProps<"/packaging/[variantId]">) {
  const { variantId } = await params;
  if (!UUID.test(variantId)) notFound();
  const { t } = await getTranslator();
  const ctx = await getSessionContext();
  const canEdit = can(ctx.membership?.role, "catalog.write");

  const data = await getVariantPackaging(variantId);
  if (!data) notFound();
  const { variant, units, lockedUnitIds } = data;
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

      <section aria-labelledby="units-h" className="space-y-4">
        <h2 id="units-h" className="text-xl font-semibold">{t("pk.units")}</h2>
        {units.length === 0 && <Alert tone="info">{t("pk.unitsNone", { unit: base })}</Alert>}

        {units.map((u) => {
          const pu = toPackUnit(u);
          const locked = lockedUnitIds.has(u.id);
          const options = activeUnits.filter((o) => o.id !== u.id).map((o) => ({ id: o.id, name: o.name }));
          return (
            <Card key={u.id} className={u.is_active ? "space-y-3" : "space-y-3 opacity-70"}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-lg font-semibold">{u.name}</p>
                {!u.is_active && <Badge>{t("pk.inactive")}</Badge>}
              </div>
              <p className="num text-muted">{u.is_active ? describeUnit(pu, activeUnits, base) : `${Number(u.base_unit_multiplier)} ${base}`}</p>
              {canEdit && (
                <>
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
