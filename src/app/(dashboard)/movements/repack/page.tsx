import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { RepackForm } from "@/components/movements/movement-forms";
import { ButtonLink } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { getTranslator } from "@/i18n/server";
import { nowLocalInput } from "@/lib/dates/business";
import { getSessionContext } from "@/server/services/session";
import { can } from "@/server/permissions";

export const metadata: Metadata = { title: "Repack stock" };

export default async function RepackPage() {
  const { t } = await getTranslator();
  const m = (await getSessionContext()).membership!;
  if (!can(m.role, "inventory.write")) redirect("/movements");
  return (
    <div className="max-w-2xl space-y-6">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-[28px] font-semibold tracking-tight">{t("mv.repack.title")}</h1>
          <p className="mt-1 text-muted">{t("mv.repack.body")}</p>
        </div>
        <ButtonLink href="/movements" variant="ghost">{t("mv.back")}</ButtonLink>
      </div>
      <Card><RepackForm defaultLocal={nowLocalInput(m.timezone)} /></Card>
    </div>
  );
}
