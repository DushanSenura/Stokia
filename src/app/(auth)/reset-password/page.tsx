import type { Metadata } from "next";
import { ResetRequestForm } from "@/components/shared/auth-forms";
import { getTranslator } from "@/i18n/server";

export const metadata: Metadata = { title: "Reset password" };

export default async function ResetPasswordPage() {
  const { t } = await getTranslator();
  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-[28px] font-semibold tracking-tight">{t("auth.reset.title")}</h1>
        <p className="mt-1 text-muted">{t("auth.reset.subtitle")}</p>
      </div>
      <ResetRequestForm />
    </div>
  );
}
