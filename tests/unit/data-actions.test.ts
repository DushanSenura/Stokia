// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const revalidate = vi.fn();
vi.mock("next/cache", () => ({ revalidatePath: (...a: unknown[]) => revalidate(...a) }));
const rpc = vi.fn();
const guard = vi.fn();
vi.mock("@/server/services/guard", () => ({ requireRole: (...a: unknown[]) => guard(...a) }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({ rpc }) }));

import { repairSalesAction, runHealthCheckAction } from "@/server/actions/data";
import { rolesFor } from "@/server/permissions";

const SHOP = "11111111-1111-4111-8111-111111111111";
const fd = (days: string) => { const f = new FormData(); f.set("days", days); return f; };
const report = { checked_at: "x", from: "y", days: 90, errors: 0, warnings: 0, checks: [] };

beforeEach(() => {
  rpc.mockReset(); revalidate.mockReset();
  guard.mockReset().mockResolvedValue({ ok: true, userId: "u", shopId: SHOP, role: "owner", supabase: { rpc } });
});

describe("runHealthCheckAction", () => {
  it("asks for the owner-only capability, and passes the shop and period to the database", async () => {
    rpc.mockResolvedValue({ data: report, error: null });
    const r = await runHealthCheckAction({}, fd("180"));
    expect(guard).toHaveBeenCalledWith(rolesFor("data.manage"));
    expect(rolesFor("data.manage")).toEqual(["owner"]);
    expect(rpc).toHaveBeenCalledWith("data_health_check", { p_shop: SHOP, p_days: 180 });
    expect(r.report).toEqual(report);
  });
  it("refuses non-owners without touching the database", async () => {
    guard.mockResolvedValue({ ok: false, error: "error.forbidden" });
    expect(await runHealthCheckAction({}, fd("90"))).toEqual({ error: "error.forbidden" });
    expect(rpc).not.toHaveBeenCalled();
  });
  it("rejects a period that is not on the list (no free-form numbers reach SQL)", async () => {
    for (const bad of ["0", "-5", "91", "abc", "", "1e9"]) {
      expect((await runHealthCheckAction({}, fd(bad))).fieldErrors?.days).toBe("data.err.range");
    }
    expect(rpc).not.toHaveBeenCalled();
  });
  it("maps a database refusal to a permission message and anything else to a generic one", async () => {
    rpc.mockResolvedValueOnce({ data: null, error: { message: "FORBIDDEN" } });
    expect((await runHealthCheckAction({}, fd("90"))).error).toBe("error.forbidden");
    rpc.mockResolvedValueOnce({ data: null, error: { message: "connection reset" } });
    const r = await runHealthCheckAction({}, fd("90"));
    expect(r.error).toBe("auth.error.generic");
    expect(JSON.stringify(r)).not.toMatch(/connection reset/); // raw database text is never shown
  });
});

describe("repairSalesAction", () => {
  it("repairs, re-checks, reports how many figures changed, and refreshes the pages that show sales", async () => {
    rpc.mockImplementation(async (fn: string) => (fn === "repair_sales" ? { data: { changed: 4, from: "x" }, error: null } : { data: report, error: null }));
    const r = await repairSalesAction({}, fd("90"));
    expect(rpc.mock.calls.map((c) => c[0])).toEqual(["repair_sales", "data_health_check"]);
    expect(r.repaired).toBe(4);
    expect(r.report).toEqual(report);
    expect(revalidate.mock.calls.map((c) => c[0])).toEqual(expect.arrayContaining(["/dashboard", "/analytics", "/reports", "/stock-history"]));
  });
  it("does not re-check or refresh anything when the repair itself fails", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: "boom" } });
    expect((await repairSalesAction({}, fd("90"))).error).toBe("auth.error.generic");
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(revalidate).not.toHaveBeenCalled();
  });
  it("refuses non-owners and invalid periods", async () => {
    guard.mockResolvedValueOnce({ ok: false, error: "error.forbidden" });
    expect(await repairSalesAction({}, fd("90"))).toEqual({ error: "error.forbidden" });
    expect((await repairSalesAction({}, fd("7"))).fieldErrors?.days).toBe("data.err.range");
    expect(rpc).not.toHaveBeenCalled();
  });
});
