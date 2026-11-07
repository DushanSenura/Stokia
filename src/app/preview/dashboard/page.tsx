import { notFound } from "next/navigation";
import { DashboardView } from "@/components/dashboard/dashboard-view";
import { Brand } from "@/components/shared/brand";
import { DEMO_TODAY, demoDashboard } from "@/features/dashboard/demo-data";
import { getTranslator } from "@/i18n/server";
import { addDays } from "@/lib/dates/business";

/**
 * Demo-data preview of the dashboard for design review and automated visual checks.
 * Returns 404 unless STOKIA_PREVIEW=1 (never set in production). Uses no database and no login.
 */
export default async function DashboardPreview({ searchParams }: PageProps<"/preview/dashboard">) {
  if (process.env.STOKIA_PREVIEW !== "1") notFound();
  const sp = await searchParams;
  const state = sp.state === "confirmed" || sp.state === "draft" ? sp.state : "none";
  const { t, locale } = await getTranslator();
  return (
    <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6">
      <div className="mb-6"><Brand href="/preview/dashboard" /></div>
      <DashboardView data={demoDashboard({ todayState: state })} yesterday={addDays(DEMO_TODAY, -1)} role="owner" t={t} locale={locale} timezone="Asia/Colombo" greeting={t("dash.greeting", { name: "Nimal" })} shopName="Perera Stores (demo data)" />
    </div>
  );
}
