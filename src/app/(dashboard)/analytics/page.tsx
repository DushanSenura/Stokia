import type { Metadata } from "next";
import { AnalyticsView } from "@/components/analytics/analytics-view";
import { Alert } from "@/components/ui/feedback";
import { getTranslator } from "@/i18n/server";
import { sizeLabel } from "@/lib/formatting/units";
import { createClient } from "@/lib/supabase/server";
import { loadAnalytics } from "@/server/repositories/analytics";
import { listCategories } from "@/server/repositories/catalog";
import { getSessionContext } from "@/server/services/session";

export const metadata: Metadata = { title: "Sales Analytics" };
const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

export default async function AnalyticsPage({ searchParams }: PageProps<"/analytics">) {
  const { t, locale } = await getTranslator();
  const m = (await getSessionContext()).membership!;
  const sp = await searchParams;
  const supabase = await createClient();

  let data;
  try {
    data = await loadAnalytics(supabase, { shopId: m.shopId, timezone: m.timezone }, {
      from: first(sp.from), to: first(sp.to), category: first(sp.category), product: first(sp.product), variant: first(sp.variant), by: first(sp.by), unit: first(sp.unit),
    });
  } catch {
    return <Alert tone="danger">{t("an.error")}</Alert>;
  }

  // Resolve the chosen product's name and sizes for the filter controls.
  let product: { id: string; label: string } | null = null;
  let productVariants: { id: string; label: string }[] = [];
  if (data.filters.product) {
    const [{ data: p }, { data: vs }] = await Promise.all([
      supabase.from("products").select("id,name").eq("id", data.filters.product).maybeSingle(),
      supabase.from("product_variants").select("id,sku,size_value,size_unit").eq("product_id", data.filters.product).order("sku"),
    ]);
    if (p) product = { id: p.id, label: p.name };
    productVariants = (vs ?? []).map((v) => ({ id: v.id, label: sizeLabel(v.size_value, v.size_unit) || v.sku }));
  }
  const categories = (await listCategories()).map((c) => ({ id: c.id, name: c.name }));

  return <AnalyticsView data={data} t={t} locale={locale} categories={categories} product={product} productVariants={productVariants} />;
}
