import { SearchX } from "lucide-react";
import { ButtonLink } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/feedback";
import { getTranslator } from "@/i18n/server";

export default async function NotFound() {
  const { t } = await getTranslator();
  return (
    <div className="grid min-h-dvh place-items-center p-6">
      <EmptyState
        icon={<SearchX className="size-6" aria-hidden />}
        title={t("error.notFoundTitle")}
        body={t("error.notFoundBody")}
        action={<ButtonLink href="/">{t("error.goHome")}</ButtonLink>}
      />
    </div>
  );
}
