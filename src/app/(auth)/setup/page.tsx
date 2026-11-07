import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { SetupShopForm } from "@/components/shared/auth-forms";
import { getTranslator } from "@/i18n/server";
import { Alert } from "@/components/ui/feedback";
import { createClient } from "@/lib/supabase/server";
import { signOutAction } from "@/server/actions/auth";
import { Button } from "@/components/ui/button";
import { getSessionContext } from "@/server/services/session";

export const metadata: Metadata = { title: "Set up your shop" };

export default async function SetupPage() {
  const { t } = await getTranslator();
  const ctx = await getSessionContext();
  if (!ctx.user) redirect("/login?next=/setup");
  if (ctx.membership) redirect("/dashboard");

  // An invited person becomes an active member the first time they sign in.
  if (ctx.inactive === "invited") {
    await (await createClient()).rpc("accept_invitation");
    redirect("/dashboard");
  }
  if (ctx.inactive === "suspended") {
    return (
      <div className="space-y-5">
        <Alert tone="warning">{t("team.suspendedNotice")}</Alert>
        <form action={signOutAction}><Button type="submit" variant="secondary" className="w-full">{t("common.signOut")}</Button></form>
      </div>
    );
  }
  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-[28px] font-semibold tracking-tight">{t("setup.title")}</h1>
        <p className="mt-1 text-muted">{t("setup.subtitle")}</p>
      </div>
      <SetupShopForm defaultTimezone="Asia/Colombo" />
    </div>
  );
}
