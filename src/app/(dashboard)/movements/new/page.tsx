import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { MovementForm } from "@/components/movements/movement-forms";
import { ButtonLink } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { getTranslator } from "@/i18n/server";
import { nowLocalInput } from "@/lib/dates/business";
import { getSessionContext } from "@/server/services/session";
import { can } from "@/server/permissions";

export const metadata: Metadata = { title: "Record movement" };

export default async function NewMovementPage() {
  const { t } = await getTranslator();
  const m = (await getSessionContext()).membership!;
  if (!can(m.role, "inventory.write")) redirect("/movements");
  return (
    <div className="max-w-2xl space-y-6">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-[28px] font-semibold tracking-tight">{t("mv.form.title")}</h1>
        <ButtonLink href="/movements" variant="ghost">{t("mv.back")}</ButtonLink>
      </div>
      <Card><MovementForm defaultLocal={nowLocalInput(m.timezone)} /></Card>
    </div>
  );
}
