import type { Metadata } from "next";
import { UpdatePasswordForm } from "@/components/shared/auth-forms";
import { getTranslator } from "@/i18n/server";

export const metadata: Metadata = { title: "New password" };

export default async function UpdatePasswordPage() {
  const { t } = await getTranslator();
  return (
    <div className="space-y-5">
      <h1 className="text-[28px] font-semibold tracking-tight">{t("auth.update.title")}</h1>
      <UpdatePasswordForm />
    </div>
  );
}
