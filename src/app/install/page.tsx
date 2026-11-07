import type { Metadata } from "next";
import { InstallGuide } from "@/components/pwa/install-guide";
import { Brand } from "@/components/shared/brand";
import { LanguageSwitcher } from "@/components/shared/language-switcher";
import { ThemeToggle } from "@/components/shared/theme-toggle";
import { getTranslator } from "@/i18n/server";

export const metadata: Metadata = { title: "Install" };

/** Public: someone setting up a shop phone needs these steps before they can sign in. */
export default async function InstallPage() {
  const { t } = await getTranslator();
  return (
    <div className="flex min-h-dvh flex-col bg-[radial-gradient(60rem_30rem_at_50%_-10%,var(--mint),transparent)]">
      <header className="flex items-center justify-between px-4 py-3 sm:px-8">
        <Brand />
        <div className="flex items-center gap-1">
          <LanguageSwitcher />
          <ThemeToggle />
        </div>
      </header>
      <main id="main" className="mx-auto w-full max-w-3xl flex-1 space-y-5 px-4 pb-16 pt-4 sm:px-6">
        <div>
          <h1 className="text-[28px] font-semibold tracking-tight sm:text-[34px]">{t("install.title")}</h1>
          <p className="mt-2 text-muted">{t("install.intro")}</p>
        </div>
        <InstallGuide />
      </main>
    </div>
  );
}
