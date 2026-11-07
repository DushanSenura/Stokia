"use client";

import { TriangleAlert } from "lucide-react";
import { useEffect } from "react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/feedback";
import { useT } from "@/providers/i18n-provider";

export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const t = useT();
  useEffect(() => {
    // Never show raw error details to users; the digest ties to server logs.
    console.error("[stokia] route error", error.digest);
  }, [error]);
  return (
    <div className="grid min-h-dvh place-items-center p-6">
      <EmptyState
        icon={<TriangleAlert className="size-6" aria-hidden />}
        title={t("error.title")}
        body={t("error.body")}
        action={<Button onClick={reset}>{t("common.retry")}</Button>}
      />
    </div>
  );
}
