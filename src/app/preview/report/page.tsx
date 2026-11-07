import { notFound } from "next/navigation";
import { ReportView } from "@/components/reports/report-view";
import { Brand } from "@/components/shared/brand";
import { demoReport } from "@/features/reports/demo-data";
import { getTranslator } from "@/i18n/server";

/** Demo-data preview of a Monthly Report (404 unless STOKIA_PREVIEW=1). ?state=pending shows an unclosed month. */
export default async function ReportPreview({ searchParams }: PageProps<"/preview/report">) {
  if (process.env.STOKIA_PREVIEW !== "1") notFound();
  const sp = await searchParams;
  const { t, locale } = await getTranslator();
  return (
    <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6">
      <div className="mb-6 print:hidden"><Brand href="/preview/dashboard" /></div>
      <ReportView report={demoReport({ closed: sp.state !== "pending" })} t={t} locale={locale} timezone="Asia/Colombo" />
    </div>
  );
}
