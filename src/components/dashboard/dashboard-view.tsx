import { ActivityCard, AlertsCard, FilterBar, KpiGrid, LowStockCard, MorningCard, QuickActions } from "@/components/dashboard/dashboard-cards";
import { DailySalesChart, MonthlyTrendChart, TopProductsChart } from "@/components/dashboard/sales-charts";
import type { DashboardData } from "@/server/repositories/dashboard";
import type { Locale, Translator } from "@/i18n";
import { can } from "@/server/permissions";

/** The dashboard layout (Bento grid). Shared by the real page and the demo preview so they can never drift apart. */
export function DashboardView({ data, yesterday, role, t, locale, timezone, greeting, shopName }: {
  data: DashboardData; yesterday: string; role: "owner" | "stock_manager" | "viewer";
  t: Translator; locale: Locale; timezone: string; greeting: string; shopName: string;
}) {
  const canCount = can(role, "inventory.write");
  const view = { t, locale, timezone };
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-[28px] font-semibold tracking-tight">{greeting}</h1>
        <p className="text-muted">{shopName}</p>
      </div>

      <MorningCard data={data} canCount={canCount} {...view} />
      {/* The morning card above already shows today's count status, so those alerts live in the bell only. */}
      <AlertsCard alerts={data.alerts.filter((a) => a.id !== "count_pending" && a.id !== "count_draft")} t={t} locale={locale} />
      <FilterBar data={data} yesterday={yesterday} t={t} locale={locale} />
      <KpiGrid data={data} yesterday={yesterday} t={t} locale={locale} />

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="min-w-0 lg:col-span-2"><DailySalesChart points={data.daily} month={data.month} /></div>
        <div className="min-w-0"><TopProductsChart items={data.top} month={data.month} /></div>
      </div>
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="min-w-0 lg:col-span-2"><MonthlyTrendChart points={data.trend} /></div>
        <LowStockCard data={data} t={t} />
      </div>
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="min-w-0 lg:col-span-2"><ActivityCard data={data} {...view} /></div>
        <QuickActions canWrite={canCount} canCreateProducts={can(role, "catalog.write")} t={t} />
      </div>
    </div>
  );
}
