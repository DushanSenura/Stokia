"use client";

import { useQuery } from "@tanstack/react-query";
import { Bell } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { alertText } from "@/features/dashboard/alert-text";
import type { DashAlert } from "@/features/dashboard/summary";
import { cn } from "@/lib/utils/cn";
import { useI18n } from "@/providers/i18n-provider";

async function fetchAlerts(): Promise<DashAlert[]> {
  const res = await fetch("/api/notifications", { cache: "no-store" });
  if (!res.ok) throw new Error("notifications");
  return ((await res.json()) as { alerts: DashAlert[] }).alerts;
}

/**
 * Derived notifications (nothing is stored): morning count owed, skipped days, results needing review,
 * low stock, a monthly report waiting on a count. Refreshes every few minutes and when the window regains focus.
 */
export function NotificationBell() {
  const { t, locale } = useI18n();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const { data: alerts = [] } = useQuery({ queryKey: ["notifications"], queryFn: fetchAlerts, staleTime: 60_000, refetchInterval: 5 * 60_000, refetchOnWindowFocus: true });
  const urgent = alerts.filter((a) => a.severity === "warning").length;

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (root.current && !root.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onKey); };
  }, [open]);

  return (
    <div ref={root} className="relative">
      <Button variant="ghost" size="icon" onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-haspopup="true"
        aria-label={alerts.length ? `${t("alert.title")} (${alerts.length})` : t("alert.title")}>
        <Bell className="size-5" aria-hidden />
        {alerts.length > 0 && (
          <span aria-hidden className={cn("num absolute right-1.5 top-1.5 grid min-w-4 place-items-center rounded-full px-1 text-[10px] font-bold leading-4 text-white", urgent ? "bg-danger dark:text-black" : "bg-info dark:text-black")}>{alerts.length}</span>
        )}
      </Button>
      {open && (
        <div role="region" aria-label={t("alert.title")} className="absolute right-0 top-12 z-50 w-80 max-w-[calc(100vw-2rem)] rounded-2xl border border-border bg-surface p-2 shadow-soft">
          <p className="px-3 py-2 text-sm font-semibold">{t("alert.title")}</p>
          {alerts.length === 0 ? <p className="px-3 pb-3 text-sm text-muted">{t("alert.none")}</p> : (
            <ul>
              {alerts.map((a) => (
                <li key={a.id}>
                  <Link href={a.href} onClick={() => setOpen(false)} className="flex gap-3 rounded-xl px-3 py-2.5 text-sm transition-colors duration-150 hover:bg-surface-soft">
                    <span aria-hidden className={cn("mt-1.5 size-2 shrink-0 rounded-full", a.severity === "warning" ? "bg-warning" : "bg-info")} />
                    <span>{alertText(a, t, locale)}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
