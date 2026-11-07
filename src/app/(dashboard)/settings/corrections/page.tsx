import type { Metadata } from "next";
import Link from "next/link";
import { CancelRequestButton, DecisionButtons } from "@/components/settings/correction-controls";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/feedback";
import { getTranslator } from "@/i18n/server";
import type { MessageKey } from "@/i18n";
import { addDays, formatBusinessDate } from "@/lib/dates/business";
import { formatShopDateTime } from "@/lib/dates/format";
import { createClient } from "@/lib/supabase/server";
import { can } from "@/server/permissions";
import { listCorrections, type CorrectionRow } from "@/server/repositories/settings";
import { getSessionContext } from "@/server/services/session";

export const metadata: Metadata = { title: "Count corrections" };
const tone = { pending: "warning", approved: "success", rejected: "danger", cancelled: "neutral" } as const;
const link = "text-sm text-action underline-offset-4 hover:underline dark:text-sage";

export default async function CorrectionsPage() {
  const { t, locale } = await getTranslator();
  const ctx = await getSessionContext();
  const m = ctx.membership!;
  const rows = await listCorrections(await createClient(), { limit: 200 });
  const pending = rows.filter((r) => r.status === "pending");
  const history = rows.filter((r) => r.status !== "pending");
  const decide = can(m.role, "corrections.decide");

  const summary = (r: CorrectionRow) => (
    <div className="min-w-0 space-y-0.5">
      <p className="font-medium">{r.product} {r.size} <span className="num font-normal text-muted">· {formatBusinessDate(r.businessDate, locale)}</span></p>
      <p className="num">{t("cor.oldNew", { old: r.oldQuantity ?? t("cor.notCounted"), new: r.newQuantity, unit: r.unit })}</p>
      <p className="text-sm text-muted">“{r.reason}”</p>
      <p className="text-xs text-muted">{t("cor.by", { name: r.requester, date: formatShopDateTime(r.createdAt, m.timezone) })}</p>
    </div>
  );

  return (
    <div className="max-w-4xl space-y-6">
      <p className="max-w-2xl text-muted">{t("cor.subtitle")}</p>

      <section aria-labelledby="pend-h" className="space-y-3">
        <h2 id="pend-h" className="text-xl font-semibold">{t("cor.pending")} <span className="num text-muted">({pending.length})</span></h2>
        {pending.length === 0 ? <p className="rounded-2xl bg-surface-soft p-4 text-sm text-muted">{t("cor.noPending")}</p> : (
          <ul className="space-y-3">
            {pending.map((r) => (
              <li key={r.id}>
                <Card className="space-y-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">{summary(r)}<Link href={`/stock-history/${r.sessionId}`} className={link}>{t("cor.viewCount")}</Link></div>
                  <p className="text-xs text-muted">{t("cor.affects", { before: formatBusinessDate(addDays(r.businessDate, -1), locale), on: formatBusinessDate(r.businessDate, locale) })}</p>
                  {decide ? <DecisionButtons correctionId={r.id} /> : r.createdBy === ctx.user!.id ? <CancelRequestButton correctionId={r.id} /> : null}
                </Card>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="hist-h" className="space-y-3">
        <h2 id="hist-h" className="text-xl font-semibold">{t("cor.history")}</h2>
        {history.length === 0 ? <p className="rounded-2xl bg-surface-soft p-4 text-sm text-muted">{t("cor.none")}</p> : (
          <ul className="space-y-3">
            {history.map((r) => (
              <li key={r.id}>
                <Card className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 space-y-1">
                    {summary(r)}
                    {r.decidedAt && (
                      <p className="text-xs text-muted">
                        {t("cor.decidedBy", { status: t(`cor.status.${r.status}` as MessageKey), name: r.decider ?? "", date: formatShopDateTime(r.decidedAt, m.timezone) })}
                        {r.decisionNote ? ` · “${r.decisionNote}”` : ""}
                      </p>
                    )}
                  </div>
                  <div className="flex items-center gap-3"><Badge tone={tone[r.status]}>{t(`cor.status.${r.status}` as MessageKey)}</Badge><Link href={`/stock-history/${r.sessionId}`} className={link}>{t("cor.viewCount")}</Link></div>
                </Card>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
