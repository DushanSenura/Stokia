import type { Metadata } from "next";
import { ShopSettingsForm } from "@/components/settings/account-forms";
import { Card } from "@/components/ui/card";
import { Alert } from "@/components/ui/feedback";
import { getTranslator } from "@/i18n/server";
import type { MessageKey } from "@/i18n";
import { createClient } from "@/lib/supabase/server";
import { can } from "@/server/permissions";
import { getShopSettings } from "@/server/repositories/settings";
import { getSessionContext } from "@/server/services/session";

export const metadata: Metadata = { title: "Shop settings" };

export default async function ShopSettingsPage() {
  const { t } = await getTranslator();
  const m = (await getSessionContext()).membership!;
  const s = await getShopSettings(await createClient(), m.shopId);
  const zones = (() => {
    const all = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.("timeZone") ?? ["Asia/Colombo"];
    return [...new Set(["Asia/Colombo", s.timezone, ...all])];
  })();

  return (
    <Card className="max-w-3xl space-y-5">
      <h2 className="text-xl font-semibold">{t("set.shop.title")}</h2>
      {can(m.role, "settings.write") ? (
        <ShopSettingsForm name={s.name} timezone={s.timezone} timezones={zones} timezoneLocked={s.timezoneLocked} policy={s.valuationPolicy} />
      ) : (
        <>
          <Alert tone="info">{t("set.readOnly")}</Alert>
          <dl className="grid gap-3 text-sm sm:grid-cols-2">
            <div><dt className="text-muted">{t("set.shop.name")}</dt><dd className="font-medium">{s.name}</dd></div>
            <div><dt className="text-muted">{t("set.shop.currency")}</dt><dd className="font-medium">LKR</dd></div>
            <div><dt className="text-muted">{t("set.shop.timezone")}</dt><dd className="font-medium">{s.timezone}</dd></div>
            <div><dt className="text-muted">{t("set.shop.valuation")}</dt><dd className="font-medium">{t(`set.shop.valuation.${s.valuationPolicy}` as MessageKey)}</dd></div>
          </dl>
        </>
      )}
    </Card>
  );
}
