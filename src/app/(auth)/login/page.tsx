import type { Metadata } from "next";
import { Alert } from "@/components/ui/feedback";
import { LoginForm } from "@/components/shared/auth-forms";
import { isSupabaseConfigured } from "@/lib/supabase/env";
import { getTranslator } from "@/i18n/server";
import { safeNextPath } from "@/server/validators/auth";

export const metadata: Metadata = { title: "Sign in" };

export default async function LoginPage({ searchParams }: PageProps<"/login">) {
  const { t } = await getTranslator();
  const sp = await searchParams;
  const next = typeof sp.next === "string" ? safeNextPath(sp.next) : undefined;
  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-[28px] font-semibold tracking-tight">{t("auth.login.title")}</h1>
        <p className="mt-1 text-muted">{t("auth.login.subtitle")}</p>
      </div>
      {!isSupabaseConfigured() && <Alert tone="warning">{t("error.supabaseMissing")}</Alert>}
      {sp.error === "callback" && <Alert tone="danger">{t("auth.error.callback")}</Alert>}
      <LoginForm next={next} />
      <p className="text-center text-sm text-muted">{t("auth.invitationOnly")}</p>
    </div>
  );
}
