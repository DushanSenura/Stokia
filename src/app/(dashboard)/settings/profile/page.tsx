import type { Metadata } from "next";
import { PasswordForm, ProfileForm, SignOutOthers } from "@/components/settings/account-forms";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/feedback";
import { getTranslator } from "@/i18n/server";
import type { MessageKey } from "@/i18n";
import { createClient } from "@/lib/supabase/server";
import { getProfile } from "@/server/repositories/settings";
import { getSessionContext } from "@/server/services/session";

export const metadata: Metadata = { title: "My profile" };

export default async function ProfilePage() {
  const { t, locale } = await getTranslator();
  const ctx = await getSessionContext();
  const m = ctx.membership!;
  const profile = await getProfile(await createClient(), ctx.user!.id);
  return (
    <div className="max-w-3xl space-y-6">
      <Card className="space-y-4">
        <h2 className="text-xl font-semibold">{t("prof.title")}</h2>
        <dl className="grid gap-3 text-sm sm:grid-cols-3">
          <div><dt className="text-muted">{t("prof.email")}</dt><dd className="break-all font-medium">{ctx.user!.email}</dd></div>
          <div><dt className="text-muted">{t("prof.shop")}</dt><dd className="font-medium">{m.shopName}</dd></div>
          <div><dt className="text-muted">{t("prof.role")}</dt><dd><Badge tone="info">{t(`common.role.${m.role}` as MessageKey)}</Badge></dd></div>
        </dl>
        <ProfileForm displayName={profile?.display_name ?? ctx.displayName} language={profile?.preferred_language ?? locale} />
      </Card>
      <Card className="space-y-6">
        <h2 className="text-xl font-semibold">{t("prof.security")}</h2>
        <PasswordForm />
        <div className="border-t border-border pt-5"><SignOutOthers /></div>
      </Card>
    </div>
  );
}
