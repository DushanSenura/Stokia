import { redirect } from "next/navigation";
import { AppShell } from "@/components/layout/app-shell";
import { getSessionContext } from "@/server/services/session";

/**
 * Server-side gate for every dashboard route (defence in depth on top of proxy.ts):
 * must be signed in AND belong to a shop. Data access is further protected by RLS.
 */
export default async function DashboardLayout({ children }: LayoutProps<"/">) {
  const ctx = await getSessionContext();
  if (!ctx.user) redirect("/login");
  if (!ctx.membership) redirect("/setup");

  return (
    <AppShell
      shopName={ctx.membership.shopName}
      role={ctx.membership.role}
      displayName={ctx.displayName}
      syncScope={`${ctx.membership.shopId}:${ctx.user.id}`}
    >
      {children}
    </AppShell>
  );
}
