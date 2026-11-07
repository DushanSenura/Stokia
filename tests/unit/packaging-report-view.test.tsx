import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ReportView } from "@/components/reports/report-view";
import { buildPackagingReport, emptyPackagingReport } from "@/features/reports/packaging-report";
import { demoReport } from "@/features/reports/demo-data";
import { createTranslator } from "@/i18n";
import { I18nProvider } from "@/providers/i18n-provider";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock("@/server/actions/reports", () => ({ recordPrintAction: vi.fn(async () => ({ ok: true })) }));

const t = createTranslator("en");
const tsi = createTranslator("si");
const line = (name: string, isBase: boolean, quantity: number, baseUnits: number, price: number) => ({ name, is_base_unit: isBase, quantity, base_units: baseUnits, unit_price: price, amount: quantity * price });
const packaging = buildPackagingReport([
  { sales_date: "2026-10-05", variant_id: "choco", product_name: "Choco", sku: "CHOCO-1", base_unit: "piece", units_sold: "145", estimated_amount: "4150.00", bucket: "known", packaging_status: "known", lines: [line("Box", false, 4, 80, 550), line("piece", true, 65, 65, 30)] },
  { sales_date: "2026-10-06", variant_id: "choco", product_name: "Choco", sku: "CHOCO-1", base_unit: "piece", units_sold: "100", estimated_amount: "3000.00", bucket: "unknown", packaging_status: "unknown", lines: null },
]);
const show = (pk = packaging, locale: "en" | "si" = "en") =>
  render(<I18nProvider locale={locale}><ReportView report={{ ...demoReport({ closed: true }), packaging: pk }} t={locale === "si" ? tsi : t} locale={locale} timezone="Asia/Colombo" /></I18nProvider>);

describe("the report's packaging section", () => {
  it("shows known, estimated and standard apart, each with its own label, amount and product-days", () => {
    show();
    const section = screen.getByRole("region", { name: "Estimated sales by certainty" });
    expect(within(section).getByText("Known packaging breakdown")).toBeInTheDocument();
    expect(within(section).getByText("Estimated, packaging unknown")).toBeInTheDocument();
    expect(within(section).getByText("Products without sellable packaging")).toBeInTheDocument();
    // each amount sits in ITS group's card (a figure may also appear again further down, in the known-products table)
    const card = (label: string) => within(section).getByText(label).closest("div")!;
    expect(within(card("Known packaging breakdown")).getByText("Rs. 4,150.00")).toBeInTheDocument();
    expect(within(card("Estimated, packaging unknown")).getByText("Rs. 3,000.00")).toBeInTheDocument();
    expect(within(card("Products without sellable packaging")).getByText("Rs. 0.00")).toBeInTheDocument();
    expect(within(section).getByText(/Total estimated sales:/)).toHaveTextContent("Rs. 7,150.00");
  });

  it("explains that the groups are never blended into one unlabelled figure", () => {
    show();
    expect(screen.getByText(/never mixed into one unlabelled figure/)).toBeInTheDocument();
  });

  it("lists the known products with the packages sold, and the days that have a known breakdown", () => {
    show();
    const section = screen.getByRole("region", { name: "Estimated sales by certainty" });
    expect(within(section).getByText("Packages sold (known)")).toBeInTheDocument();
    expect(within(section).getByText("4 Box · 65 piece")).toBeInTheDocument();
    expect(within(section).getByText("Known")).toBeInTheDocument();
    expect(within(section).getByText("Estimated")).toBeInTheDocument();
  });

  it("says plainly when there are no known breakdowns this month", () => {
    show(buildPackagingReport([{ sales_date: "2026-10-06", variant_id: "choco", product_name: "Choco", sku: "C", base_unit: "piece", units_sold: "100", estimated_amount: "3000.00", bucket: "unknown", packaging_status: "unknown", lines: null }]));
    expect(screen.getByText("No known packaging breakdowns this month.")).toBeInTheDocument();
  });

  it("is not shown at all for a shop that does not sell in packages (no clutter)", () => {
    show(emptyPackagingReport());
    expect(screen.queryByRole("region", { name: "Estimated sales by certainty" })).not.toBeInTheDocument();
  });

  it("reads in Sinhala too", () => {
    show(packaging, "si");
    expect(screen.getByRole("region", { name: "නිශ්චිතභාවය අනුව ඇස්තමේන්තු විකුණුම්" })).toBeInTheDocument();
    expect(screen.getByText("දන්නා ඇසුරුම් බෙදීම")).toBeInTheDocument();
  });
});
