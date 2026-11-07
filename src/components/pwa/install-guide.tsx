"use client";

import { Download, Share, Smartphone } from "lucide-react";
import { useEffect, useState, useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/feedback";
import { Card } from "@/components/ui/card";
import { useI18n } from "@/providers/i18n-provider";

/** Chrome's install event (not in the standard DOM types). */
interface InstallPromptEvent extends Event { prompt: () => Promise<void>; userChoice: Promise<{ outcome: "accepted" | "dismissed" }> }

const subscribeNone = () => () => undefined;
const isStandalone = () =>
  window.matchMedia("(display-mode: standalone)").matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
const isIphone = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

/** Install steps for Android and iPhone; a real install button where the browser offers one (Chrome / Edge on Android and desktop). */
export function InstallGuide() {
  const { t } = useI18n();
  const standalone = useSyncExternalStore(subscribeNone, isStandalone, () => false);
  const iphone = useSyncExternalStore(subscribeNone, isIphone, () => false);
  const [prompt, setPrompt] = useState<InstallPromptEvent | null>(null);

  useEffect(() => {
    const onPrompt = (e: Event) => { e.preventDefault(); setPrompt(e as InstallPromptEvent); };
    const onInstalled = () => setPrompt(null);
    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);
    return () => { window.removeEventListener("beforeinstallprompt", onPrompt); window.removeEventListener("appinstalled", onInstalled); };
  }, []);

  const steps = (prefix: "install.android" | "install.iphone") => (
    <ol className="mt-3 list-decimal space-y-2 pl-5">
      {([1, 2, 3, 4] as const).map((n) => <li key={n}>{t(`${prefix}.${n}` as const)}</li>)}
    </ol>
  );

  return (
    <div className="space-y-5">
      {standalone && <Alert tone="success">{t("install.installed")}</Alert>}
      {prompt && !standalone && (
        <Button size="lg" onClick={async () => { await prompt.prompt(); await prompt.userChoice; setPrompt(null); }}>
          <Download className="size-5" aria-hidden />{t("install.button")}
        </Button>
      )}

      <div className="grid gap-4 md:grid-cols-2">
        <Card className={iphone ? "order-2" : undefined}>
          <h2 className="flex items-center gap-2 text-lg font-semibold"><Smartphone className="size-5 text-action" aria-hidden />{t("install.android.title")}</h2>
          {steps("install.android")}
        </Card>
        <Card className={iphone ? "order-1 ring-2 ring-action" : undefined}>
          <h2 className="flex items-center gap-2 text-lg font-semibold"><Share className="size-5 text-action" aria-hidden />{t("install.iphone.title")}</h2>
          {steps("install.iphone")}
        </Card>
      </div>

      <Card>
        <h2 className="text-lg font-semibold">{t("install.note.title")}</h2>
        <p className="mt-2 text-muted">{t("install.note.body")}</p>
      </Card>
    </div>
  );
}
