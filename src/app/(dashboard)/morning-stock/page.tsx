import type { Metadata } from "next";
import { CheckCircle2 } from "lucide-react";
import { MorningStockEntry } from "@/components/stock/morning-stock-entry";
import { ButtonLink } from "@/components/ui/button";
import { Alert } from "@/components/ui/feedback";
import { getTranslator } from "@/i18n/server";
import { formatBusinessDate } from "@/lib/dates/business";
import { createClient } from "@/lib/supabase/server";
import { loadMorningStock } from "@/server/services/morning-stock";
import { getSessionContext } from "@/server/services/session";
import { can } from "@/server/permissions";

export const metadata: Metadata = { title: "Morning Stock" };

export default async function MorningStockPage({ searchParams }: PageProps<"/morning-stock">) {
  const { t, locale } = await getTranslator();
  const ctx = await getSessionContext();
  const m = ctx.membership!; // dashboard layout guarantees a membership
  const sp = await searchParams;

  const supabase = await createClient();
  const data = await loadMorningStock(supabase, m, typeof sp.date === "string" ? sp.date : undefined);
  const dateLabel = formatBusinessDate(data.businessDate, locale);

  // A confirmed count is final here (corrections need a reason + approval).
  if (data.confirmedSessionId) {
    return (
      <div className="mx-auto max-w-xl space-y-5 py-8 text-center">
        <CheckCircle2 className="mx-auto size-14 text-primary" aria-hidden />
        <h1 className="text-[28px] font-semibold tracking-tight">{t("ms.status.confirmed")}</h1>
        <Alert tone="success">{t("ms.confirmedBanner", { date: dateLabel })}</Alert>
        <div className="flex flex-wrap justify-center gap-3">
          <ButtonLink href={`/stock-history/${data.confirmedSessionId}`} size="lg">{t("ms.viewCount")}</ButtonLink>
          <ButtonLink href="/dashboard" variant="secondary" size="lg">{t("nav.dashboard")}</ButtonLink>
        </div>
      </div>
    );
  }

  return (
    <MorningStockEntry
      key={`${data.businessDate}:${data.session?.id ?? "new"}:${data.session?.revision ?? 0}`} // remount only when the server copy really changed (Reload / discard)
      shopName={m.shopName}
      businessDate={data.businessDate}
      salesDate={data.salesDate}
      items={data.items}
      initialValues={data.initialValues}
      session={data.session}
      previousDate={data.previousDate}
      gapDays={data.gapDays}
      readOnly={!can(m.role, "inventory.write")}
      truncated={data.truncated}
      draftScope={`${m.shopId}:${ctx.user!.id}`}
    />
  );
}
