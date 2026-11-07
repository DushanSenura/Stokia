import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ReportView } from "@/components/reports/report-view";
import { Alert } from "@/components/ui/feedback";
import { getTranslator } from "@/i18n/server";
import { shopLocalDate } from "@/lib/dates/format";
import { createClient } from "@/lib/supabase/server";
import { loadMonthlyReport, validReportMonth } from "@/server/repositories/reports";
import { getSessionContext } from "@/server/services/session";

export const metadata: Metadata = { title: "Monthly report" };

export default async function ReportPage({ params }: PageProps<"/reports/[month]">) {
  const { month } = await params;
  const { t, locale } = await getTranslator();
  const m = (await getSessionContext()).membership!;
  if (!validReportMonth(month, shopLocalDate(new Date(), m.timezone))) notFound();

  let report;
  try { report = await loadMonthlyReport(await createClient(), { shopId: m.shopId, shopName: m.shopName, timezone: m.timezone }, month); }
  catch { return <Alert tone="danger">{t("rep.error")}</Alert>; }
  return <ReportView report={report} t={t} locale={locale} timezone={m.timezone} />;
}
