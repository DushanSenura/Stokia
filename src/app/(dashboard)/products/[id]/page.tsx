import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ArchiveRestore, Archive } from "lucide-react";
import { ImageForm, PriceForm, ProductForm, VariantForm } from "@/components/products/catalog-forms";
import { Button, ButtonLink } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Alert, Badge } from "@/components/ui/feedback";
import { getTranslator } from "@/i18n/server";
import { formatShopDateTime } from "@/lib/dates/format";
import { formatLkr } from "@/lib/formatting/money";
import { sizeLabel } from "@/lib/formatting/units";
import { listCategories, getProductDetail } from "@/server/repositories/catalog";
import { setProductActiveAction, setVariantActiveAction } from "@/server/actions/catalog";
import { getSessionContext } from "@/server/services/session";
import { can } from "@/server/permissions";

export const metadata: Metadata = { title: "Product" };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function ProductPage({ params }: PageProps<"/products/[id]">) {
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const { t } = await getTranslator();
  const ctx = await getSessionContext();
  const canEdit = can(ctx.membership?.role, "catalog.write");
  const tz = ctx.membership?.timezone;

  const [detail, categories] = await Promise.all([getProductDetail(id), listCategories()]);
  if (!detail) notFound();
  const { product, variants, prices } = detail;

  return (
    <div className="max-w-4xl space-y-8">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-[28px] font-semibold tracking-tight">{product.name}</h1>
          <p className="num text-muted">{product.product_code}</p>
        </div>
        <div className="flex items-center gap-2">
          <Badge tone={product.is_active ? "success" : "neutral"}>{product.is_active ? t("cat.products.active") : t("cat.products.archived")}</Badge>
          <ButtonLink href="/products" variant="ghost">{t("cat.categories.back")}</ButtonLink>
        </div>
      </div>

      {!product.is_active && <Alert tone="warning">{t("cat.form.archivedNote")}</Alert>}

      {canEdit ? (
        <Card className="space-y-6">
          <ProductForm product={product} categories={categories} />
          <div className="flex flex-wrap items-start gap-6 border-t border-border pt-5">
            {product.image_url && (
              // eslint-disable-next-line @next/next/no-img-element -- remote Supabase Storage URL
              <img src={product.image_url} alt={product.name} width={96} height={96} loading="lazy" className="size-24 rounded-2xl border border-border object-cover" />
            )}
            <div className="min-w-60 flex-1"><ImageForm productId={product.id} /></div>
          </div>
          <form action={setProductActiveAction.bind(null, product.id, !product.is_active)} className="border-t border-border pt-5">
            <Button type="submit" variant={product.is_active ? "danger" : "secondary"}>
              {product.is_active ? <Archive className="size-4" aria-hidden /> : <ArchiveRestore className="size-4" aria-hidden />}
              {product.is_active ? t("cat.form.archive") : t("cat.form.restore")}
            </Button>
          </form>
        </Card>
      ) : (
        <Card>
          {product.description && <p>{product.description}</p>}
          <p className="mt-2 text-sm text-muted">{t("cat.products.readOnly")}</p>
        </Card>
      )}

      <section aria-labelledby="variants-h" className="space-y-4">
        <div>
          <h2 id="variants-h" className="text-xl font-semibold">{t("cat.variants.title")}</h2>
          <p className="text-sm text-muted">{t("cat.variants.separateNote")}</p>
        </div>

        {variants.length === 0 && <Alert tone="info">{t("cat.variants.none")}</Alert>}

        {variants.map((v) => {
          const vp = prices.filter((p) => p.variant_id === v.id);
          const current = (type: "selling" | "purchase_cost") => vp.find((p) => p.price_type === type && p.effective_to === null);
          const selling = current("selling");
          const cost = current("purchase_cost");
          return (
            <Card key={v.id} className={v.is_active ? "space-y-4" : "space-y-4 opacity-70"}>
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <p className="text-lg font-semibold">{sizeLabel(v.size_value, v.size_unit) || t("cat.variants.noSize")}</p>
                  <p className="num text-sm text-muted">{v.sku} · {v.base_inventory_unit}{v.barcode ? ` · ${v.barcode}` : ""}</p>
                </div>
                {!v.is_active && <Badge>{t("cat.variants.inactive")}</Badge>}
              </div>

              <dl className="grid grid-cols-2 gap-3">
                <div className="rounded-xl bg-surface-soft p-3">
                  <dt className="text-xs text-muted">{t("cat.price.selling")}</dt>
                  <dd className="num text-lg font-semibold">{selling ? formatLkr(selling.amount_lkr) : t("cat.price.notSet")}</dd>
                </div>
                <div className="rounded-xl bg-surface-soft p-3">
                  <dt className="text-xs text-muted">{t("cat.price.cost")}</dt>
                  <dd className="num text-lg font-semibold">{cost ? formatLkr(cost.amount_lkr) : t("cat.price.notSet")}</dd>
                </div>
              </dl>

              <ButtonLink href={`/packaging/${v.id}`} variant="secondary">{t("nav.packaging")}</ButtonLink>

              {canEdit && (
                <>
                  <details className="group rounded-xl border border-border p-4">
                    <summary className="flex min-h-11 cursor-pointer items-center font-medium">{t("cat.price.set")}</summary>
                    <div className="mt-3 space-y-2">
                      <PriceForm productId={product.id} variantId={v.id} />
                      <p className="text-xs text-muted">{t("cat.price.note")}</p>
                    </div>
                  </details>
                  <details className="rounded-xl border border-border p-4">
                    <summary className="flex min-h-11 cursor-pointer items-center font-medium">{t("common.edit")}</summary>
                    <div className="mt-3"><VariantForm productId={product.id} variant={v} /></div>
                  </details>
                </>
              )}

              {vp.length > 0 && (
                <details className="rounded-xl border border-border p-4">
                  <summary className="flex min-h-11 cursor-pointer items-center font-medium">{t("cat.price.history")}</summary>
                  <div className="mt-3 overflow-x-auto">
                    <table className="w-full min-w-[28rem] text-left text-sm">
                      <thead className="text-muted">
                        <tr><th className="py-1.5 pr-3 font-medium">{t("cat.price.type")}</th><th className="py-1.5 pr-3 font-medium">{t("cat.price.amount")}</th><th className="py-1.5 pr-3 font-medium">{t("cat.price.from")}</th><th className="py-1.5 font-medium">{t("cat.price.to")}</th></tr>
                      </thead>
                      <tbody className="num">
                        {vp.map((p) => (
                          <tr key={p.id} className="border-t border-border">
                            <td className="py-1.5 pr-3">{p.price_type === "selling" ? t("cat.price.selling") : t("cat.price.cost")}</td>
                            <td className="py-1.5 pr-3">{formatLkr(p.amount_lkr)}</td>
                            <td className="py-1.5 pr-3">{formatShopDateTime(p.effective_from, tz)}</td>
                            <td className="py-1.5">{p.effective_to ? formatShopDateTime(p.effective_to, tz) : t("cat.price.present")}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </details>
              )}

              {canEdit && (
                <form action={setVariantActiveAction.bind(null, product.id, v.id, !v.is_active)}>
                  <Button type="submit" variant="ghost">{v.is_active ? t("cat.variants.deactivate") : t("cat.variants.activate")}</Button>
                </form>
              )}
            </Card>
          );
        })}

        {canEdit && (
          <Card>
            <h3 className="mb-4 font-semibold">{t("cat.variants.add")}</h3>
            <VariantForm productId={product.id} />
          </Card>
        )}
      </section>
    </div>
  );
}
