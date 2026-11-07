import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ActivityCard, AlertsCard, FilterBar, KpiGrid, LowStockCard, MorningCard } from "@/components/dashboard/dashboard-cards";
import { DailySalesChart, MonthlyTrendChart, TopProductsChart } from "@/components/dashboard/sales-charts";
import { NotificationBell } from "@/components/layout/notification-bell";
import { DEMO_TODAY, demoDashboard } from "@/features/dashboard/demo-data";
import { createTranslator } from "@/i18n";
import { I18nProvider } from "@/providers/i18n-provider";
import type { DashboardData } from "@/server/repositories/dashboard";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));

const t = createTranslator("en");
const view = { t, locale: "en" as const, timezone: "Asia/Colombo" };
const YESTERDAY = "2026-11-05";
const withI18n = (ui: React.ReactNode) => <I18nProvider locale="en">{ui}</I18nProvider>;
const demo = (over: Partial<DashboardData> = {}) => ({ ...demoDashboard(), ...over });

describe("KpiGrid", () => {
  it("shows PENDING (not zero, not an old figure) when this morning's count has not been entered", () => {
    render(<KpiGrid data={demo()} yesterday={YESTERDAY} t={t} locale="en" />);
    expect(screen.getAllByText("Pending")).toHaveLength(2); // sales + units tiles
    expect(screen.getAllByText("Waiting for the next morning's count.").length).toBe(2);
    expect(screen.getByText("Yesterday's Estimated Sales")).toBeInTheDocument();
  });

  it("shows the calculated figure and units once the day is calculated, with a note when some products are missing", () => {
    render(<KpiGrid data={demo({ yesterday: { kind: "value", amount: "4200.00", units: { packet: "28" }, needsReview: 1, pending: 2 } })} yesterday={YESTERDAY} t={t} locale="en" />);
    expect(screen.getByText("Rs. 4,200.00")).toBeInTheDocument();
    expect(screen.getByText("Not complete: 2 pending, 1 need review.")).toBeInTheDocument();
  });

  it("explains a day that cannot be worked out because a morning was skipped", () => {
    render(<KpiGrid data={demo({ yesterday: { kind: "pending", reason: "missing_count" } })} yesterday={YESTERDAY} t={t} locale="en" />);
    expect(screen.getAllByText(/A morning count was skipped/).length).toBe(2);
  });

  it("lists units separately and never adds packets to bottles", () => {
    render(<KpiGrid data={demo()} yesterday={YESTERDAY} t={t} locale="en" />);
    const tile = screen.getByText("Monthly Units Sold").closest("div")!.parentElement!;
    expect(within(tile).getByText("716")).toBeInTheDocument();
    expect(within(tile).getByText("85")).toBeInTheDocument();
    expect(within(tile).queryByText("801")).not.toBeInTheDocument();
  });

  it("labels stock value as 'at cost, from a given count' and warns about uncosted products", () => {
    render(<KpiGrid data={demo()} yesterday={YESTERDAY} t={t} locale="en" />);
    expect(screen.getByText("Rs. 412,350.00")).toBeInTheDocument();
    expect(screen.getByText(/At cost, from the 5 Nov count/)).toBeInTheDocument();
    expect(screen.getByText(/3 counted products have no purchase cost/)).toBeInTheDocument();
  });

  it("states that a month is in progress / waiting for its closing count", () => {
    const { rerender } = render(<KpiGrid data={demo()} yesterday={YESTERDAY} t={t} locale="en" />);
    expect(screen.getByText("In progress")).toBeInTheDocument();
    rerender(<KpiGrid data={demo({ month: "2026-10", monthStatus: { status: "pending", waitingFor: "2026-11-01" } })} yesterday={YESTERDAY} t={t} locale="en" />);
    expect(screen.getByText(/Waiting for the 1 Nov count/)).toBeInTheDocument();
  });

  it("with no data at all it shows dashes and an honest message", () => {
    render(<KpiGrid data={demo({ yesterday: { kind: "none" }, valuation: null, activeProducts: 0, low: { items: [], total: 0 }, pendingCounts: 1,
      monthTotals: { amount: "0.00", units: {}, calculated: 0, needsReview: 0, pending: 0, throughDate: null } })} yesterday={YESTERDAY} t={t} locale="en" />);
    expect(screen.getByText("No confirmed count yet")).toBeInTheDocument();
    expect(screen.getByText(/No sales calculated this month yet/)).toBeInTheDocument();
    expect(screen.getAllByText("—").length).toBeGreaterThanOrEqual(3);
  });

  it("uses the chosen date in the label when it is not yesterday", () => {
    render(<KpiGrid data={demo({ salesDate: "2026-11-02" })} yesterday={YESTERDAY} t={t} locale="en" />);
    expect(screen.getByText("Estimated Sales · 2 Nov")).toBeInTheDocument();
    expect(screen.getByText("Units Sold · 2 Nov")).toBeInTheDocument();
  });

  it("covers all eight required KPIs", () => {
    render(<KpiGrid data={demo()} yesterday={YESTERDAY} t={t} locale="en" />);
    for (const k of ["Yesterday's Estimated Sales", "Yesterday's Units Sold", "Monthly Estimated Sales", "Monthly Units Sold", "Current Stock Value", "Total Active Products", "Low Stock Products", "Pending Stock Counts"]) {
      expect(screen.getByText(k)).toBeInTheDocument();
    }
  });
});

describe("MorningCard (the page's primary action)", () => {
  const card = (data: DashboardData, canCount = true) => render(<MorningCard data={data} canCount={canCount} {...view} />);
  it("shows the count date AND the sales date it calculates, plus the last completed count", () => {
    card(demo());
    expect(screen.getByText("6 November 2026")).toBeInTheDocument();
    expect(screen.getAllByText("5 November 2026").length).toBeGreaterThan(0);
    expect(screen.getByRole("link", { name: /5 Nov 2026.*Nimal Perera/ })).toHaveAttribute("href", "/stock-history/demo-session-4");
  });
  it("offers 'Enter Morning Stock' when not started, 'Continue' for a draft", () => {
    card(demoDashboard());
    expect(screen.getByRole("link", { name: "Enter Morning Stock" })).toHaveAttribute("href", "/morning-stock");
  });
  it("continues a draft", () => {
    card(demoDashboard({ todayState: "draft" }));
    expect(screen.getByRole("link", { name: "Continue today's draft" })).toBeInTheDocument();
  });
  it("when confirmed, replaces the button with a confirmation and a link to the count", () => {
    card(demoDashboard({ todayState: "confirmed" }));
    expect(screen.getByText("Today's count is confirmed")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Enter Morning Stock" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "View count" })).toBeInTheDocument();
  });
  it("viewers see no entry button", () => {
    card(demo(), false);
    expect(screen.queryByRole("link", { name: "Enter Morning Stock" })).not.toBeInTheDocument();
    expect(screen.getByText(/Only owners and stock managers/)).toBeInTheDocument();
  });
  it("says so when no count was ever confirmed", () => {
    card(demo({ morning: { ...demo().morning, last: null } }));
    expect(screen.getByText(/No count confirmed yet/)).toBeInTheDocument();
  });
});

describe("FilterBar", () => {
  it("steps months, disables 'next' at the current month, and offers a reset when filtered", () => {
    render(<FilterBar data={demo({ month: "2026-11", salesDate: "2026-11-03" })} yesterday={YESTERDAY} t={t} locale="en" />);
    expect(screen.getByRole("link", { name: "Previous month" })).toHaveAttribute("href", "/dashboard?month=2026-10&date=2026-11-03");
    expect(screen.queryByRole("link", { name: "Next month" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Back to yesterday" })).toBeInTheDocument();
    expect(screen.getByLabelText("Sales date")).toHaveAttribute("max", YESTERDAY);
  });
  it("is clean when showing the defaults", () => {
    render(<FilterBar data={demo({ month: "2026-11", salesDate: YESTERDAY })} yesterday={YESTERDAY} t={t} locale="en" />);
    expect(screen.queryByRole("link", { name: "Back to yesterday" })).not.toBeInTheDocument();
  });
  it("allows going forward from a past month", () => {
    render(<FilterBar data={demo({ month: "2026-09" })} yesterday={YESTERDAY} t={t} locale="en" />);
    expect(screen.getByRole("link", { name: "Next month" })).toHaveAttribute("href", "/dashboard?month=2026-10&date=2026-11-05".replace("&date=2026-11-05", ""));
  });
});

describe("alerts, low stock, activity", () => {
  it("renders alert sentences with formatted dates and links", () => {
    render(<AlertsCard alerts={[{ id: "report_pending", severity: "info", href: "/reports", params: { month: "2026-10", date: "2026-11-01" } }, { id: "counts_skipped", severity: "warning", href: "/stock-history", params: { days: 2, date: "2026-11-03" } }]} t={t} locale="en" />);
    expect(screen.getByText("The October 2026 report is waiting for the 1 November 2026 count.")).toBeInTheDocument();
    expect(screen.getByText(/2 morning count\(s\) were skipped since 3 November 2026/)).toBeInTheDocument();
  });
  it("renders nothing when there is nothing to flag", () => {
    const { container } = render(<AlertsCard alerts={[]} t={t} locale="en" />);
    expect(container).toBeEmptyDOMElement();
  });
  it("low stock: out-of-stock is called out, the rest show level, and the overflow count is stated", () => {
    render(<LowStockCard data={demo()} t={t} />);
    expect(screen.getAllByText("Out of stock").length).toBe(2); // description + badge
    expect(screen.getByText("6 packet left (level 15)")).toBeInTheDocument();
    expect(screen.getByText("and 3 more")).toBeInTheDocument();
  });
  it("low stock empty state", () => {
    render(<LowStockCard data={demo({ low: { items: [], total: 0 } })} t={t} />);
    expect(screen.getByText(/No products are at or below/)).toBeInTheDocument();
  });
  it("activity: mixes counts and movements and links through", () => {
    render(<ActivityCard data={demo()} {...view} />);
    expect(screen.getByText("Stock received")).toBeInTheDocument();
    expect(screen.getAllByText("Morning count confirmed")).toHaveLength(2);
    expect(screen.getByText("Count for 5 November 2026")).toBeInTheDocument();
  });
  it("activity empty state", () => {
    render(<ActivityCard data={demo({ activity: [] })} {...view} />);
    expect(screen.getByText(/Nothing yet/)).toBeInTheDocument();
  });
});

describe("charts (table views are the accessible equivalent of every chart)", () => {
  it("daily chart: lists only days with figures, marks pending days as pending, links to the explaining count", () => {
    const d = demo();
    render(withI18n(<DailySalesChart points={d.daily} month="2026-11" />));
    const table = screen.getByRole("table", { hidden: true });
    expect(within(table).getByText("Rs. 34,500.00")).toBeInTheDocument();
    expect(within(table).getByText("Pending")).toBeInTheDocument();
    expect(within(table).getAllByText("Calculated").length).toBeGreaterThan(0);
    // a pending day shows a dash, never "Rs. 0.00"
    expect(within(table).queryByText("Rs. 0.00")).not.toBeInTheDocument();
    expect(within(table).getAllByRole("link", { hidden: true }).length).toBeGreaterThan(0);
  });
  it("daily chart legend names every encoding (texture + label, never colour alone)", () => {
    render(withI18n(<DailySalesChart points={demo().daily} month="2026-11" />));
    for (const k of ["Calculated", "Some products pending or need review", "Needs review", "Pending"]) expect(screen.getAllByText(k).length).toBeGreaterThan(0);
  });
  it("daily chart empty state", () => {
    const empty = demo().daily.map((p) => ({ ...p, status: "none" as const, amount: null }));
    render(withI18n(<DailySalesChart points={empty} month="2026-11" />));
    expect(screen.getByText(/Nothing calculated for this period yet/)).toBeInTheDocument();
  });
  it("trend chart: months that are not closed say what they are waiting for", () => {
    render(withI18n(<MonthlyTrendChart points={demo().trend} />));
    const table = screen.getByRole("table", { hidden: true });
    expect(within(table).getByText("In progress")).toBeInTheDocument();
    expect(within(table).getAllByText("Complete").length).toBeGreaterThan(3);
    expect(within(table).getAllByText(/Waiting for the/).length).toBeGreaterThan(0);
    expect(screen.getByText("Complete month")).toBeInTheDocument();
    expect(screen.getByText("Not complete yet")).toBeInTheDocument();
  });
  it("top products: ranked by Estimated Sales, units kept with their own unit", () => {
    render(withI18n(<TopProductsChart items={demo().top} month="2026-11" />));
    const rows = within(screen.getByRole("table", { hidden: true })).getAllByRole("row", { hidden: true }).slice(1);
    expect(rows[0]).toHaveTextContent("Chilli Powder 250 g");
    expect(rows[0]).toHaveTextContent("Rs. 46,800.00");
    expect(rows[1]).toHaveTextContent("85 bottle");
  });
});

describe("NotificationBell", () => {
  const fetchMock = vi.fn();
  beforeEach(() => { fetchMock.mockReset(); vi.stubGlobal("fetch", fetchMock); });
  const setup = () => render(withI18n(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><NotificationBell /></QueryClientProvider>));

  it("shows how many things need attention, and lists them in plain language with links", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ alerts: demo().alerts }) });
    setup();
    const bell = await screen.findByRole("button", { name: "Notifications (3)" });
    await userEvent.click(bell);
    expect(await screen.findByText(`Morning stock for ${DEMO_TODAY.replace("2026-11-06", "6 November 2026")} has not been entered yet.`)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /7 products are low on stock/ })).toHaveAttribute("href", "/dashboard#low-stock");
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("region", { name: "Notifications" })).not.toBeInTheDocument());
  });
  it("says everything is up to date when there is nothing to flag", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ alerts: [] }) });
    setup();
    await userEvent.click(await screen.findByRole("button", { name: "Notifications" }));
    expect(await screen.findByText("You are all caught up.")).toBeInTheDocument();
  });
  it("degrades quietly when the request fails (no crash, no badge)", async () => {
    fetchMock.mockResolvedValue({ ok: false, json: async () => ({}) });
    setup();
    expect(await screen.findByRole("button", { name: "Notifications" })).toBeInTheDocument();
  });
});
