import { SettingsNav } from "@/components/settings/settings-nav";
import { getTranslator } from "@/i18n/server";
import { can } from "@/server/permissions";
import { getSessionContext } from "@/server/services/session";

export default async function SettingsLayout({ children }: LayoutProps<"/settings">) {
  const { t } = await getTranslator();
  const m = (await getSessionContext()).membership!;
  return (
    <div className="space-y-6">
      <h1 className="text-[28px] font-semibold tracking-tight">{t("set.title")}</h1>
      <SettingsNav canAudit={can(m.role, "audit.read")} canData={can(m.role, "data.manage")} />
      <div>{children}</div>
    </div>
  );
}
