import type { Metadata } from "next";
import { DashboardView } from "@/components/dashboard/dashboard-view";
import { Alert } from "@/components/ui/feedback";
import { getTranslator } from "@/i18n/server";
import { addDays, isBusinessDate, isMonth } from "@/lib/dates/business";
import { shopLocalDate } from "@/lib/dates/format";
import { createClient } from "@/lib/supabase/server";
import { loadDashboard } from "@/server/repositories/dashboard";
import { getSessionContext } from "@/server/services/session";

export const metadata: Metadata = { title: "Dashboard" };
const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

export default async function DashboardPage({ searchParams }: PageProps<"/dashboard">) {
  const { t, locale } = await getTranslator();
  const ctx = await getSessionContext();
  const m = ctx.membership!; // the dashboard layout guarantees a membership
  const sp = await searchParams;
  const month = first(sp.month);
  const date = first(sp.date);

  let data;
  try {
    data = await loadDashboard(await createClient(), { shopId: m.shopId, timezone: m.timezone }, {
      month: isMonth(month) ? month : undefined, salesDate: isBusinessDate(date) ? date : undefined,
    });
  } catch {
    return <Alert tone="danger">{t("error.body")}</Alert>;
  }

  return (
    <DashboardView
      data={data} yesterday={addDays(shopLocalDate(new Date(), m.timezone), -1)} role={m.role}
      t={t} locale={locale} timezone={m.timezone} greeting={t("dash.greeting", { name: ctx.displayName })} shopName={m.shopName}
    />
  );
}
