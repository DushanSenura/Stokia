// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { demoReport } from "@/features/reports/demo-data";

vi.mock("server-only", () => ({}));
const ctx = vi.fn();
vi.mock("@/server/services/session", () => ({ getSessionContext: () => ctx() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({}) }));
const load = vi.fn();
const record = vi.fn();
vi.mock("@/server/repositories/reports", async () => {
  const real = await vi.importActual<typeof import("@/server/repositories/reports")>("@/server/repositories/reports").catch(() => null);
  return {
    loadMonthlyReport: (...a: unknown[]) => load(...a),
    recordExport: (...a: unknown[]) => record(...a),
    // same rule as production: a real month from 2000 up to the current month
    validReportMonth: real?.validReportMonth ?? ((m: unknown, today: string) => typeof m === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(m) && m >= "2000-01" && m <= today.slice(0, 7)),
  };
});

import { GET } from "@/app/api/reports/[month]/[format]/route";

const call = (month: string, format: string) => GET(new Request("http://x") as never, { params: Promise.resolve({ month, format }) });
const member = (role = "viewer") => ({ user: { id: "u" }, membership: { shopId: "s", shopName: "Perera Stores", timezone: "Asia/Colombo", role } });

beforeEach(() => {
  ctx.mockReset().mockResolvedValue(member());
  load.mockReset().mockResolvedValue(demoReport());
  record.mockReset().mockResolvedValue(true);
});

describe("GET /api/reports/[month]/[format]", () => {
  it("rejects anonymous users and users without a shop", async () => {
    ctx.mockResolvedValue({ user: null, membership: null });
    expect((await call("2026-10", "pdf")).status).toBe(401);
    ctx.mockResolvedValue({ user: { id: "u" }, membership: null });
    expect((await call("2026-10", "pdf")).status).toBe(401);
    expect(load).not.toHaveBeenCalled();
  });

  it("rejects unknown formats and invalid or future months before doing any work", async () => {
    expect((await call("2026-10", "docx")).status).toBe(400);
    for (const bad of ["2026-13", "Oct-2026", "1999-12", "2999-01", "../../etc"]) expect((await call(bad, "csv")).status, bad).toBe(400);
    expect(load).not.toHaveBeenCalled();
  });

  it.each([
    ["pdf", "application/pdf", "%PDF-"],
    ["xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "PK"],
    ["csv", "text/csv; charset=utf-8", "﻿Stokia Monthly Report"],
  ])("%s: returns a real file with safe headers, and LOGS the export with the data version", async (fmt, type, magic) => {
    const res = await call("2026-10", fmt);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe(type);
    expect(res.headers.get("Content-Disposition")).toBe(`attachment; filename="stokia-report-2026-10-perera-stores-demo-data.${fmt}"`);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    const body = Buffer.from(await res.arrayBuffer()).toString("latin1");
    expect(body.startsWith(fmt === "csv" ? "ï»¿Stokia Monthly Report" : magic)).toBe(true);
    expect(record).toHaveBeenCalledTimes(1);
    expect(record.mock.calls[0][1]).toBe("s");                       // the caller's shop
    expect(record.mock.calls[0][3]).toBe(fmt);                       // which format
    expect(record.mock.calls[0][4]).toMatchObject({ estimatedSales: "133100.00", status: "complete" });
  });

  it("viewers may export (read access), and the report is built for the caller's own shop", async () => {
    await call("2026-10", "csv");
    expect(load.mock.calls[0][1]).toEqual({ shopId: "s", shopName: "Perera Stores", timezone: "Asia/Colombo" });
    expect(load.mock.calls[0][2]).toBe("2026-10");
  });

  it("refuses to hand out a file whose export could not be logged (the log is the audit trail)", async () => {
    record.mockResolvedValue(false);
    const res = await call("2026-10", "pdf");
    expect(res.status).toBe(500);
    expect(res.headers.get("Content-Type")).toContain("application/json");
  });

  it("a failure while building the report returns a generic error, not internals, and logs nothing", async () => {
    load.mockRejectedValue(new Error("relation daily_sales does not exist"));
    const res = await call("2026-10", "xlsx");
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toMatch(/relation|daily_sales/);
    expect(record).not.toHaveBeenCalled();
  });
});
