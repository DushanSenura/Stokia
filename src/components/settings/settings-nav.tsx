"use client";

import { ClipboardCheck, Database, ScrollText, Store, UserRound, Users } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils/cn";
import { useT } from "@/providers/i18n-provider";
import type { MessageKey } from "@/i18n";

const ITEMS: { href: string; label: MessageKey; icon: typeof Store; needs?: "audit" | "data" }[] = [
  { href: "/settings/profile", label: "set.nav.profile", icon: UserRound },
  { href: "/settings/shop", label: "set.nav.shop", icon: Store },
  { href: "/settings/team", label: "set.nav.team", icon: Users },
  { href: "/settings/corrections", label: "set.nav.corrections", icon: ClipboardCheck },
  { href: "/settings/audit", label: "set.nav.audit", icon: ScrollText, needs: "audit" },
  { href: "/settings/data", label: "set.nav.data", icon: Database, needs: "data" },
];

/** Settings sections. The audit log is only listed for people who may read it (the server enforces it regardless). */
export function SettingsNav({ canAudit, canData = false }: { canAudit: boolean; canData?: boolean }) {
  const t = useT();
  const pathname = usePathname();
  return (
    <nav aria-label={t("set.title")} className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
      <ul className="flex min-w-max gap-1 rounded-2xl bg-surface-soft p-1">
        {ITEMS.filter((i) => (i.needs !== "audit" || canAudit) && (i.needs !== "data" || canData)).map((i) => {
          const active = pathname === i.href || pathname.startsWith(`${i.href}/`);
          const Icon = i.icon;
          return (
            <li key={i.href}>
              <Link href={i.href} aria-current={active ? "page" : undefined}
                className={cn("inline-flex min-h-11 items-center gap-2 rounded-xl px-4 text-sm font-medium transition-colors duration-150", active ? "bg-surface shadow-soft" : "text-muted hover:text-foreground")}>
                <Icon className="size-4" aria-hidden />{t(i.label)}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
