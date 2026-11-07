"use client";

import { RefreshCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/providers/i18n-provider";

/**
 * Registers the service worker (production only: in development its caching would hide your own changes) and tells the
 * person when a newer version is waiting. The update is applied only when they choose, never in the middle of a count.
 */
export function PwaRegistrar() {
  const { t } = useI18n();
  const [waiting, setWaiting] = useState<ServiceWorker | null>(null);
  const updating = useRef(false);

  useEffect(() => {
    if (process.env.NODE_ENV !== "production" || !("serviceWorker" in navigator)) return;
    const sw = navigator.serviceWorker;
    let registration: ServiceWorkerRegistration | undefined;

    // The first install also fires `controllerchange` (the worker claims the page). Only reload for an update the person asked for.
    const onControllerChange = () => { if (updating.current) window.location.reload(); };
    sw.addEventListener("controllerchange", onControllerChange);

    sw.register("/sw.js", { scope: "/", updateViaCache: "none" })
      .then((reg) => {
        registration = reg;
        if (reg.waiting && sw.controller) setWaiting(reg.waiting);
        reg.addEventListener("updatefound", () => {
          const incoming = reg.installing;
          incoming?.addEventListener("statechange", () => {
            if (incoming.state === "installed" && sw.controller) setWaiting(incoming);
          });
        });
      })
      .catch(() => undefined); // no service worker = still a normal website

    const onVisible = () => { if (document.visibilityState === "visible") registration?.update().catch(() => undefined); };
    document.addEventListener("visibilitychange", onVisible);
    return () => { sw.removeEventListener("controllerchange", onControllerChange); document.removeEventListener("visibilitychange", onVisible); };
  }, []);

  if (!waiting) return null;
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-20 z-50 flex justify-center px-4 md:bottom-6 print:hidden">
      <div role="status" className="pointer-events-auto flex flex-wrap items-center gap-3 rounded-2xl border border-border bg-surface px-4 py-3 text-sm shadow-soft">
        <RefreshCw className="size-4 text-action" aria-hidden />
        <span>{t("pwa.update")}</span>
        <Button size="md" onClick={() => { updating.current = true; waiting.postMessage({ type: "SKIP_WAITING" }); }}>{t("pwa.updateNow")}</Button>
      </div>
    </div>
  );
}
