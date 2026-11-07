import { notFound } from "next/navigation";
import { AnalyticsView } from "@/components/analytics/analytics-view";
import { Brand } from "@/components/shared/brand";
import { demoAnalytics } from "@/features/reports/demo-data";
import { getTranslator } from "@/i18n/server";

/** Demo-data preview of Sales Analytics (404 unless STOKIA_PREVIEW=1). No database, no login. */
export default async function AnalyticsPreview() {
  if (process.env.STOKIA_PREVIEW !== "1") notFound();
  const { t, locale } = await getTranslator();
  return (
    <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6">
      <div className="mb-6"><Brand href="/preview/dashboard" /></div>
      <AnalyticsView data={demoAnalytics()} t={t} locale={locale} categories={[{ id: "c1", name: "Spices" }, { id: "c2", name: "Oils" }]} product={null} productVariants={[]} />
    </div>
  );
}
