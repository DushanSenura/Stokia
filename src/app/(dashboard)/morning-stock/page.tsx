import type { Metadata } from "next";
import { CheckCircle2 } from "lucide-react";
import { MorningStockEntry } from "@/components/stock/morning-stock-entry";
import { ButtonLink } from "@/components/ui/button";
import { Alert } from "@/components/ui/feedback";
import { getTranslator } from "@/i18n/server";
import { formatBusinessDate } from "@/lib/dates/business";
import { createClient } from "@/lib/supabase/server";
import { RecountPanel } from "@/components/stock/recount-panel";
import { RecountSheet } from "@/components/stock/recount-sheet";
import { loadMorningStock } from "@/server/services/morning-stock";
import { loadRecountSheet, loadRecountState } from "@/server/services/recount";
import { getSessionContext } from "@/server/services/session";
import { can } from "@/server/permissions";

export const metadata: Metadata = { title: "Stock Sheet" };

export default async function MorningStockPage({ searchParams }: PageProps<"/morning-stock">) {
  const { t, locale } = await getTranslator();
  const ctx = await getSessionContext();
  const m = ctx.membership!; // dashboard layout guarantees a membership
  const sp = await searchParams;

  const supabase = await createClient();
  const data = await loadMorningStock(supabase, m, typeof sp.date === "string" ? sp.date : undefined);
  const dateLabel = formatBusinessDate(data.businessDate, locale);

  // One stock sheet a day. Another one on the same day needs the owner's approval, and only the stock manager who asked can use it.
  const recountCtx = { supabase, shopId: m.shopId, userId: ctx.user!.id, role: m.role, timezone: m.timezone };
  if (typeof sp.recount === "string") {
    const sheet = await loadRecountSheet(recountCtx, sp.recount);
    if (!sheet) {
      return (
        <div className="mx-auto max-w-xl space-y-5 py-8 text-center">
          <Alert tone="warning">{t("rc.sheet.closed")}</Alert>
          <ButtonLink href="/morning-stock" variant="secondary" size="lg">{t("nav.morningStock")}</ButtonLink>
        </div>
      );
    }
    return <RecountSheet requestId={sp.recount} items={sheet.items} initialValues={sheet.initialValues} currentBase={sheet.currentBase} truncated={sheet.truncated} />;
  }

  // A confirmed count is final here (a change needs a reason and the owner's approval).
  if (data.confirmedSessionId) {
    const canAsk = m.role === "owner" || m.role === "stock_manager";
    const recount = canAsk ? await loadRecountState(recountCtx, data.confirmedSessionId, data.businessDate) : null;
    return (
      <div className="mx-auto max-w-xl space-y-5 py-8 text-center">
        <CheckCircle2 className="mx-auto size-14 text-primary" aria-hidden />
        <h1 className="text-[28px] font-semibold tracking-tight">{t("ms.status.confirmed")}</h1>
        <Alert tone="success">{t("ms.confirmedBanner", { date: dateLabel })}</Alert>
        <div className="flex flex-wrap justify-center gap-3">
          <ButtonLink href={`/stock-history/${data.confirmedSessionId}`} size="lg">{t("ms.viewCount")}</ButtonLink>
          <ButtonLink href="/dashboard" variant="secondary" size="lg">{t("nav.dashboard")}</ButtonLink>
        </div>
        {recount && <RecountPanel state={recount} isOwner={m.role === "owner"} timezone={m.timezone} sheetHref={(id) => `/morning-stock?recount=${id}`} />}
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
