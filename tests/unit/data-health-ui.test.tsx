import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DataHealth } from "@/components/settings/data-health";
import { SettingsNav } from "@/components/settings/settings-nav";
import type { HealthReport } from "@/server/repositories/data";
import { I18nProvider } from "@/providers/i18n-provider";

vi.mock("next/navigation", () => ({ usePathname: () => "/settings/data", useRouter: () => ({ refresh: vi.fn() }) }));
const check = vi.fn();
const repair = vi.fn();
vi.mock("@/server/actions/data", () => ({
  runHealthCheckAction: (...a: unknown[]) => check(...a),
  repairSalesAction: (...a: unknown[]) => repair(...a),
}));

const wrap = (ui: React.ReactNode, locale: "en" | "si" = "en") => <I18nProvider locale={locale}>{ui}</I18nProvider>;
const report = (over: Partial<HealthReport> = {}): HealthReport => ({
  checked_at: "2026-11-06T04:00:00Z", from: "2026-08-08", days: 90, errors: 0, warnings: 0, checks: [], ...over,
});
const bad = report({
  errors: 1, warnings: 1,
  checks: [
    { key: "stored_sales_differ_from_recalculation", severity: "error", count: 3, sample: [] },
    { key: "active_products_without_selling_price", severity: "warning", count: 2, sample: ["aaa", "bbb"] },
    { key: "old_unconfirmed_drafts", severity: "warning", count: 0, sample: [] },
  ],
});

beforeEach(() => { check.mockReset(); repair.mockReset(); vi.restoreAllMocks(); });

describe("Data health panel", () => {
  it("runs the check for the chosen period and says everything is fine when it is", async () => {
    check.mockResolvedValue({ report: report() });
    render(wrap(<DataHealth />));
    await userEvent.selectOptions(screen.getByLabelText("Check the last"), "180");
    await userEvent.click(screen.getByRole("button", { name: "Run the check" }));
    expect(await screen.findByText(/No problems found/)).toBeInTheDocument();
    const fd = check.mock.calls[0][1] as FormData;
    expect(fd.get("days")).toBe("180");
  });

  it("lists only the checks that found something, in plain words, with severity", async () => {
    check.mockResolvedValue({ report: bad });
    render(wrap(<DataHealth />));
    await userEvent.click(screen.getByRole("button", { name: "Run the check" }));
    expect(await screen.findByText("1 problems and 1 warnings found.")).toBeInTheDocument();
    expect(screen.getByText("3 stored sales figures do not match what your counts and movements give today.")).toBeInTheDocument();
    expect(screen.getByText("2 active products have no selling price, so their sales cannot be valued.")).toBeInTheDocument();
    expect(screen.queryByText(/count drafts have been left/)).not.toBeInTheDocument(); // zero-count checks stay hidden
    expect(screen.getByText("Problem")).toBeInTheDocument();
    expect(screen.getByText("Warning")).toBeInTheDocument();
    expect(screen.getByText(/aaa, bbb/)).toBeInTheDocument();
  });

  it("warnings alone are not reported as problems", async () => {
    check.mockResolvedValue({ report: report({ warnings: 2, checks: [{ key: "old_unconfirmed_drafts", severity: "warning", count: 2, sample: [] }] }) });
    render(wrap(<DataHealth />));
    await userEvent.click(screen.getByRole("button", { name: "Run the check" }));
    expect(await screen.findByText("No problems, but 2 things need your attention.")).toBeInTheDocument();
  });

  it("repair asks first; saying no does nothing; saying yes recalculates for the same period and shows what changed", async () => {
    repair.mockResolvedValue({ report: report(), repaired: 3 });
    const confirm = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValueOnce(true);
    render(wrap(<DataHealth initialReport={bad} />));
    await userEvent.selectOptions(screen.getByLabelText("Check the last"), "30");
    await userEvent.click(screen.getByRole("button", { name: "Recalculate sales" }));
    expect(repair).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Recalculate sales" }));
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(await screen.findByText("Recalculated. 3 figures changed.")).toBeInTheDocument();
    expect(await screen.findByText(/No problems found/)).toBeInTheDocument();
    expect((repair.mock.calls[0][1] as FormData).get("days")).toBe("30");
  });

  it("says plainly when a repair found nothing to change", async () => {
    repair.mockResolvedValue({ report: report(), repaired: 0 });
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(wrap(<DataHealth />));
    await userEvent.click(screen.getByRole("button", { name: "Recalculate sales" }));
    expect(await screen.findByText("Recalculated. Nothing needed to change.")).toBeInTheDocument();
  });

  it("shows a failure instead of pretending it worked", async () => {
    check.mockResolvedValue({ error: "error.forbidden" });
    render(wrap(<DataHealth />));
    await userEvent.click(screen.getByRole("button", { name: "Run the check" }));
    expect(await screen.findByText("You do not have permission to do that.")).toBeInTheDocument();
  });

  it("offers the backup download as a real file link, with the privacy note", () => {
    render(wrap(<DataHealth />));
    const link = screen.getByRole("link", { name: /Download backup file/ });
    expect(link).toHaveAttribute("href", "/api/exports/backup");
    expect(link).toHaveAttribute("download");
    expect(screen.getByText(/does not include anyone's e-mail address or password/)).toBeInTheDocument();
    expect(screen.getByText(/recorded in the audit log/)).toBeInTheDocument();
  });

  it("buttons are disabled while a check is running", async () => {
    let release: (v: unknown) => void = () => {};
    check.mockReturnValue(new Promise((r) => { release = r; }));
    render(wrap(<DataHealth />));
    await userEvent.click(screen.getByRole("button", { name: "Run the check" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Checking…" })).toBeDisabled());
    expect(screen.getByRole("button", { name: "Recalculate sales" })).toBeDisabled();
    release({ report: report() });
    await screen.findByText(/No problems found/);
  });
});

describe("Settings navigation: Data tab", () => {
  it("is shown to owners only", () => {
    const { rerender } = render(wrap(<SettingsNav canAudit canData />));
    expect(screen.getByRole("link", { name: "Data" })).toBeInTheDocument();
    rerender(wrap(<SettingsNav canAudit={false} canData={false} />));
    expect(screen.queryByRole("link", { name: "Data" })).not.toBeInTheDocument();
  });
  it("is in Sinhala", () => {
    render(wrap(<SettingsNav canAudit canData />, "si"));
    expect(screen.getByRole("link", { name: "දත්ත" })).toBeInTheDocument();
  });
});
