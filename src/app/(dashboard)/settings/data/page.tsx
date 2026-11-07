import type { Metadata } from "next";
import { DataHealth } from "@/components/settings/data-health";
import { Alert } from "@/components/ui/feedback";
import { getTranslator } from "@/i18n/server";
import { can } from "@/server/permissions";
import { getSessionContext } from "@/server/services/session";

export const metadata: Metadata = { title: "Data health and backup" };

export default async function DataPage() {
  const { t } = await getTranslator();
  const m = (await getSessionContext()).membership!;
  if (!can(m.role, "data.manage")) return <Alert tone="info">{t("data.ownerOnly")}</Alert>;
  return (
    <div className="max-w-3xl space-y-4">
      <h2 className="sr-only">{t("data.title")}</h2>
      <DataHealth />
    </div>
  );
}
