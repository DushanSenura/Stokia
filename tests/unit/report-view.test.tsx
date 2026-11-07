import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AnalyticsView } from "@/components/analytics/analytics-view";
import { ReportView } from "@/components/reports/report-view";
import { demoAnalytics, demoReport } from "@/features/reports/demo-data";
import { createTranslator } from "@/i18n";
import { I18nProvider } from "@/providers/i18n-provider";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock("@/server/actions/reports", () => ({ recordPrintAction: vi.fn(async () => ({ ok: true })) }));

const t = createTranslator("en");
const wrap = (ui: React.ReactNode) => <I18nProvider locale="en">{ui}</I18nProvider>;

describe("ReportView", () => {
  const show = (closed = true) => render(wrap(<ReportView report={demoReport({ closed })} t={t} locale="en" timezone="Asia/Colombo" />));

  it("has the branding, shop, title, period, generated time and currency", () => {
    show();
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Monthly report: October 2026");
    expect(screen.getByText(/Perera Stores \(demo data\)/)).toBeInTheDocument();
    expect(screen.getByText(/1 October 2026 – 31 October 2026/)).toBeInTheDocument();
    expect(screen.getByText(/Generated 06 Nov 2026, 14:00 \(Asia\/Colombo\)/)).toBeInTheDocument();
    expect(screen.getByText(/Count Today\. Know Yesterday\./)).toBeInTheDocument();
  });

  it("states what the figures are: inferred quantities and ESTIMATED sales, not cash", () => {
    show();
    expect(screen.getByText(/Units sold are inferred from morning stock counts/)).toBeInTheDocument();
    expect(screen.getByText(/They are not confirmed cash receipts/)).toBeInTheDocument();
    expect(screen.getByText("Inferred units × selling price. Not cash received.")).toBeInTheDocument();
    expect(screen.getByText(/at purchase cost \(not selling price\)/)).toBeInTheDocument();
  });

  it("shows Complete, Recalculated and 'Changed since export' badges together when they all apply", () => {
    show();
    expect(screen.getByText("Complete")).toBeInTheDocument();
    expect(screen.getByText("Recalculated")).toBeInTheDocument();
    expect(screen.getByText("Changed since export")).toBeInTheDocument();
    expect(screen.getByText(/figures changed after the last export/)).toBeInTheDocument();
  });

  it("an unclosed month says what it is waiting for (month boundary rule)", () => {
    show(false);
    expect(screen.getByText("Waiting for the 1 November 2026 count")).toBeInTheDocument();
    expect(screen.getByText(/The last day of the month is calculated by the 1 November 2026 count, which has not been confirmed yet/)).toBeInTheDocument();
  });

  it("offers PDF, Excel, CSV (logged download routes) and Print", () => {
    show();
    expect(screen.getByRole("link", { name: "PDF" })).toHaveAttribute("href", "/api/reports/2026-10/pdf");
    expect(screen.getByRole("link", { name: "Excel" })).toHaveAttribute("href", "/api/reports/2026-10/xlsx");
    expect(screen.getByRole("link", { name: "CSV" })).toHaveAttribute("href", "/api/reports/2026-10/csv");
    expect(screen.getByRole("button", { name: "Print" })).toBeInTheDocument();
  });

  it("totals stock PER UNIT: packets and bottles are separate rows, never one number", () => {
    show();
    const table = screen.getAllByRole("table")[0];
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent("bottle");
    expect(rows[0]).toHaveTextContent("85");
    expect(rows[1]).toHaveTextContent("packet");
    expect(rows[1]).toHaveTextContent("740");
    expect(screen.getByText(/Zero means the month adds up exactly/)).toBeInTheDocument();
  });

  it("explains every caveat instead of hiding it", () => {
    show();
    expect(screen.getByText(/Product-days needing review: 1/)).toBeInTheDocument();
    expect(screen.getByText(/Product-days that could not be calculated: 31/)).toBeInTheDocument();
    expect(screen.getByText(/Products with no opening count: 1/)).toBeInTheDocument();
    expect(screen.getByText(/Products in stock with no purchase cost: 1/)).toBeInTheDocument();
  });

  it("per-size rows flag problems, show blanks as a dash (never zero) and keep Sinhala names intact", () => {
    show();
    expect(screen.getByText("මිරිස් කුඩු")).toBeInTheDocument();
    const sinhala = screen.getByText("මිරිස් කුඩු").closest("tr")!;
    expect(sinhala).toHaveTextContent("no opening count");
    expect(within(sinhala).getAllByText("—").length).toBeGreaterThan(0);
    expect(screen.getByText("needs review, no purchase cost")).toBeInTheDocument();
  });

  it("daily table shows only days with figures; low stock is listed", () => {
    show();
    expect(screen.getByText("Daily Estimated Sales")).toBeInTheDocument();
    expect(screen.getByText("Some products pending or need review")).toBeInTheDocument();
    expect(screen.getByText("Low-stock items")).toBeInTheDocument();
    expect(screen.getAllByText("Sugar").length).toBeGreaterThanOrEqual(2); // products table and the low-stock list
  });

  it("is print-friendly: controls are hidden when printing", () => {
    show();
    expect(screen.getByRole("link", { name: "PDF" }).parentElement).toHaveClass("print:hidden");
  });
});

describe("AnalyticsView", () => {
  const show = () => render(wrap(<AnalyticsView data={demoAnalytics()} t={t} locale="en" categories={[{ id: "c1", name: "Spices" }]} product={null} productVariants={[]} />));

  it("has a date-range filter first, presets, category/product/size filters", () => {
    show();
    expect(screen.getByLabelText("From")).toHaveValue("2026-10-06");
    expect(screen.getByLabelText("To")).toHaveValue("2026-11-05");
    expect(screen.getByLabelText("To")).toHaveAttribute("max", "2026-11-05");
    expect(screen.getByRole("link", { name: "Last 30 days" })).toHaveAttribute("href", "/analytics?from=2026-10-07&to=2026-11-05");
    expect(screen.getByRole("link", { name: "Last month" })).toHaveAttribute("href", "/analytics?from=2026-10-01&to=2026-10-31");
    expect(screen.getByLabelText("Category")).toBeInTheDocument();
    expect(screen.getByLabelText("Size")).toBeDisabled();           // no product chosen yet
  });

  it("shows headline figures with units listed separately and honest coverage", () => {
    show();
    expect(screen.getAllByText("Rs. 743,350.00").length).toBeGreaterThan(0);
    expect(screen.getByText("30 of 31 days")).toBeInTheDocument();
    expect(screen.getByText(/1 partly calculated, 0 need review, 1 pending, 0 without a count/)).toBeInTheDocument();
    const units = screen.getByText("Units sold", { selector: "div,span,p" }).closest("div")!.parentElement!;
    expect(within(units).getByText("bottle")).toBeInTheDocument();
    expect(within(units).getByText("packet")).toBeInTheDocument();
  });

  it("day / week / month toggle keeps the other filters in the link", () => {
    show();
    expect(screen.getByRole("link", { name: "Week" })).toHaveAttribute("href", expect.stringContaining("by=week"));
    expect(screen.getByRole("link", { name: "Week" })).toHaveAttribute("href", expect.stringContaining("from=2026-10-06"));
    expect(screen.getByRole("link", { name: "Day" })).toHaveAttribute("aria-current", "true");
  });

  it("month over month compares like for like while the month is still in progress", () => {
    show();
    expect(screen.getByText(/November 2026 so far, compared with the same first 5 days of October 2026/)).toBeInTheDocument();
  });

  it("product-wise, size-wise and slow-mover tables; zero-sales products are listed", () => {
    show();
    expect(screen.getByText("Product-wise sales")).toBeInTheDocument();
    expect(screen.getByText("Size-wise sales")).toBeInTheDocument();
    expect(screen.getByText(/Sizes that sold nothing come first/)).toBeInTheDocument();
    expect(screen.getAllByText("Ceylon Tea").length).toBeGreaterThan(0);
  });

  it("movement trend offers a unit switch (quantities of different units are never combined)", () => {
    show();
    const group = screen.getByRole("group", { name: "Unit" });
    expect(within(group).getByRole("link", { name: "bottle" })).toHaveAttribute("href", expect.stringContaining("unit=bottle"));
    expect(screen.getByText("Stock movements (packet)")).toBeInTheDocument();
  });

  it("reminds that Estimated Sales are not cash", () => {
    show();
    expect(screen.getByText(/They are not confirmed cash received/)).toBeInTheDocument();
  });
});
