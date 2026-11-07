"use client";

import { motion } from "motion/react";
import { ChevronsLeft, ChevronsRight, Ellipsis, LogOut, X } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { useLocalFlag } from "@/hooks/use-local-flag";
import { Brand } from "@/components/shared/brand";
import { NotificationBell } from "@/components/layout/notification-bell";
import { LanguageSwitcher } from "@/components/shared/language-switcher";
import { ThemeToggle } from "@/components/shared/theme-toggle";
import { Badge } from "@/components/ui/feedback";
import { NAV_ITEMS, type NavItem } from "@/constants/nav";
import { cn } from "@/lib/utils/cn";
import { useT } from "@/providers/i18n-provider";
import { clearAllLocalDrafts } from "@/lib/offline/draft-store";
import { clearAllQueued } from "@/lib/offline/sync-queue";
import { SyncBanner } from "@/components/sync/sync-banner";
import { SyncProvider, useSync } from "@/providers/sync-provider";
import { signOutAction } from "@/server/actions/auth";
import type { MessageKey } from "@/i18n";

interface ShellProps {
  shopName: string;
  role: "owner" | "stock_manager" | "viewer";
  displayName: string;
  /** `shopId:userId`. When set, counts that cannot reach the server wait on this device and are sent automatically. */
  syncScope?: string;
  children: React.ReactNode;
}

const isActive = (pathname: string, href: string) => pathname === href || pathname.startsWith(`${href}/`);

function NavLink({ item, collapsed, onNavigate }: { item: NavItem; collapsed?: boolean; onNavigate?: () => void }) {
  const t = useT();
  const pathname = usePathname();
  const active = isActive(pathname, item.href);
  const Icon = item.icon;
  return (
    <Link
      href={item.href}
      onClick={onNavigate}
      aria-current={active ? "page" : undefined}
      title={collapsed ? t(item.label) : undefined}
      className={cn(
        "flex min-h-11 items-center gap-3 rounded-xl px-3 text-[15px] font-medium transition-colors duration-150",
        active ? "bg-mint text-mint-foreground" : "text-muted hover:bg-surface-soft hover:text-foreground",
        collapsed && "justify-center px-0",
      )}
    >
      <Icon className="size-5 shrink-0" aria-hidden />
      {!collapsed && <span className="truncate">{t(item.label)}</span>}
      {collapsed && <span className="sr-only">{t(item.label)}</span>}
    </Link>
  );
}

function SignOutButton({ collapsed }: { collapsed?: boolean }) {
  const t = useT();
  const { entries } = useSync();
  return (
    <form
      action={signOutAction}
      onSubmit={(e) => {
        // Counts waiting to be sent exist only on this device: signing out deletes them, so ask first.
        if (entries.length > 0 && !window.confirm(t("sync.signOutWarning", { count: entries.length }))) { e.preventDefault(); return; }
        void clearAllLocalDrafts();
        void clearAllQueued();
      }}
    >
      <button
        type="submit"
        className={cn(
          "flex min-h-11 w-full items-center gap-3 rounded-xl px-3 text-[15px] font-medium text-muted transition-colors duration-150 hover:bg-surface-soft hover:text-foreground",
          collapsed && "justify-center px-0",
        )}
      >
        <LogOut className="size-5" aria-hidden />
        {collapsed ? <span className="sr-only">{t("common.signOut")}</span> : t("common.signOut")}
      </button>
    </form>
  );
}

export function AppShell({ syncScope, ...props }: ShellProps) {
  // The provider sits outside the shell body so the sign-out button and the banner can both read the queue.
  return syncScope ? <SyncProvider scope={syncScope}><Shell {...props} /></SyncProvider> : <Shell {...props} />;
}

function Shell({ shopName, role, displayName, children }: Omit<ShellProps, "syncScope">) {
  const t = useT();
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useLocalFlag("stokia-sidebar");
  // "More" sheet is tied to the path it was opened on, so navigating closes it.
  const [moreFor, setMoreFor] = useState<string | null>(null);
  const moreOpen = moreFor === pathname;
  const setMoreOpen = (open: boolean) => setMoreFor(open ? pathname : null);
  const toggle = () => setCollapsed((c) => !c);

  const mobilePrimary = NAV_ITEMS.filter((i) => i.primaryOnMobile);
  const mobileMore = NAV_ITEMS.filter((i) => !i.primaryOnMobile);
  const moreActive = mobileMore.some((i) => isActive(pathname, i.href));

  return (
    <div className="flex min-h-dvh">
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-[60] focus:rounded-lg focus:bg-action focus:px-4 focus:py-2 focus:text-action-foreground">
        {t("nav.skip")}
      </a>

      {/* Desktop / tablet sidebar */}
      <motion.aside
        initial={false}
        animate={{ width: collapsed ? 76 : 260 }}
        transition={{ duration: 0.22, ease: "easeOut" }}
        className="sticky top-0 hidden h-dvh shrink-0 flex-col gap-2 border-r border-border bg-surface p-3 md:flex print:!hidden"
      >
        <div className={cn("flex h-12 items-center", collapsed ? "justify-center" : "px-1")}>
          <Brand href="/dashboard" showText={!collapsed} />
        </div>
        <nav aria-label="Main" className="mt-2 flex flex-1 flex-col gap-1 overflow-y-auto">
          {NAV_ITEMS.map((item) => (
            <NavLink key={item.href} item={item} collapsed={collapsed} />
          ))}
        </nav>
        <SignOutButton collapsed={collapsed} />
        <button
          type="button"
          onClick={toggle}
          aria-label={collapsed ? t("nav.expand") : t("nav.collapse")}
          className="flex min-h-11 items-center justify-center rounded-xl text-muted transition-colors duration-150 hover:bg-surface-soft hover:text-foreground"
        >
          {collapsed ? <ChevronsRight className="size-5" aria-hidden /> : <ChevronsLeft className="size-5" aria-hidden />}
        </button>
      </motion.aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="glass sticky top-0 z-30 flex min-h-16 items-center justify-between gap-3 border-x-0 border-t-0 px-4 sm:px-6 print:hidden">
          <div className="flex min-w-0 items-center gap-3">
            <div className="md:hidden">
              <Brand href="/dashboard" showText={false} />
            </div>
            <div className="min-w-0">
              <p className="truncate font-semibold leading-tight">{shopName}</p>
              <p className="truncate text-xs text-muted">{displayName}</p>
            </div>
            <Badge tone="info" className="hidden sm:inline-flex">
              {t(`common.role.${role}` as MessageKey)}
            </Badge>
          </div>
          <div className="flex items-center gap-1">
            <NotificationBell />
            <LanguageSwitcher />
            <ThemeToggle />
          </div>
        </header>

        <SyncBanner />
        <main id="main" className="mx-auto w-full max-w-7xl flex-1 px-4 py-6 pb-28 sm:px-6 md:pb-10 print:max-w-none print:p-0">
          {children}
        </main>
      </div>

      {/* Mobile bottom navigation */}
      <nav
        aria-label="Primary"
        className="glass safe-bottom fixed inset-x-0 bottom-0 z-40 grid grid-cols-5 border-x-0 border-b-0 md:hidden print:hidden"
      >
        {mobilePrimary.map((item) => {
          const active = isActive(pathname, item.href);
          const Icon = item.icon;
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={active ? "page" : undefined}
              className={cn(
                "flex min-h-14 flex-col items-center justify-center gap-0.5 text-[11px] font-medium transition-colors duration-150",
                active ? "text-action dark:text-sage" : "text-muted",
              )}
            >
              <Icon className="size-5" aria-hidden />
              <span className="max-w-full truncate px-1">{t(item.label)}</span>
            </Link>
          );
        })}
        <button
          type="button"
          onClick={() => setMoreOpen(true)}
          aria-expanded={moreOpen}
          aria-haspopup="dialog"
          className={cn(
            "flex min-h-14 flex-col items-center justify-center gap-0.5 text-[11px] font-medium",
            moreActive ? "text-action dark:text-sage" : "text-muted",
          )}
        >
          <Ellipsis className="size-5" aria-hidden />
          {t("nav.more")}
        </button>
      </nav>

      {moreOpen && (
        <div className="fixed inset-0 z-50 md:hidden" role="dialog" aria-modal="true" aria-label={t("nav.more")}>
          <button type="button" aria-label={t("common.close")} className="absolute inset-0 bg-black/40" onClick={() => setMoreOpen(false)} />
          <motion.div
            initial={{ y: 40, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            transition={{ duration: 0.22, ease: "easeOut" }}
            className="safe-bottom absolute inset-x-0 bottom-0 rounded-t-3xl border border-border bg-surface p-4 shadow-soft"
          >
            <div className="mb-2 flex items-center justify-between">
              <p className="font-semibold">{t("nav.more")}</p>
              <button type="button" onClick={() => setMoreOpen(false)} aria-label={t("common.close")} className="grid size-11 place-items-center rounded-xl hover:bg-surface-soft">
                <X className="size-5" aria-hidden />
              </button>
            </div>
            <div className="flex flex-col gap-1">
              {mobileMore.map((item) => (
                <NavLink key={item.href} item={item} onNavigate={() => setMoreOpen(false)} />
              ))}
              <SignOutButton />
            </div>
          </motion.div>
        </div>
      )}
    </div>
  );
}
