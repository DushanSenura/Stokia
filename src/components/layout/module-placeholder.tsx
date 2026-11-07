import { Hammer } from "lucide-react";
import { EmptyState } from "@/components/ui/feedback";
import { NAV_ITEMS } from "@/constants/nav";
import { getTranslator } from "@/i18n/server";

/** Honest "not built yet" page for modules scheduled in later phases (no fake UI). */
export async function ModulePlaceholder({ href }: { href: string }) {
  const { t } = await getTranslator();
  const item = NAV_ITEMS.find((i) => i.href === href);
  if (!item) return null;
  return (
    <div className="space-y-6">
      <h1 className="text-[28px] font-semibold tracking-tight">{t(item.label)}</h1>
      <EmptyState
        icon={<Hammer className="size-6" aria-hidden />}
        title={t("common.comingIn", { phase: item.phase ?? "?" })}
        body={t("common.notBuiltYet")}
      />
    </div>
  );
}
