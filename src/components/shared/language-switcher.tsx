"use client";

import { Languages } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { LOCALES, LOCALE_LABELS, type Locale } from "@/i18n";
import { setLocaleAction } from "@/server/actions/preferences";
import { useI18n } from "@/providers/i18n-provider";
import { cn } from "@/lib/utils/cn";

export function LanguageSwitcher({ className }: { className?: string }) {
  const { locale, t } = useI18n();
  const router = useRouter();
  const [pending, start] = useTransition();
  const next: Locale = LOCALES.find((l) => l !== locale) ?? "en";
  return (
    <button
      type="button"
      disabled={pending}
      onClick={() =>
        start(async () => {
          await setLocaleAction(next);
          router.refresh();
        })
      }
      aria-label={`${t("common.language")}: ${LOCALE_LABELS[next]}`}
      className={cn(
        "inline-flex min-h-11 items-center gap-2 rounded-xl px-3 text-sm font-medium transition-colors duration-150 hover:bg-surface-soft disabled:opacity-60",
        className,
      )}
    >
      <Languages className="size-5" aria-hidden />
      {LOCALE_LABELS[next]}
    </button>
  );
}
