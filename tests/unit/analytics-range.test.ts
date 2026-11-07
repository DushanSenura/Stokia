// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({}) }));

import { MAX_RANGE_DAYS, resolveRange } from "@/server/repositories/analytics";

const TODAY = "2026-11-06";

describe("resolveRange", () => {
  it("defaults to this month so far, up to yesterday", () => {
    expect(resolveRange({}, TODAY)).toEqual({ from: "2026-11-01", to: "2026-11-05", days: 5, clamped: false });
  });
  it("on the 1st of a month (no days yet) falls back to the previous month's days instead of an empty/inverted range", () => {
    const r = resolveRange({}, "2026-11-01");
    expect(r.to).toBe("2026-10-31");
    expect(r.from).toBe("2026-10-01");
  });
  it("today and the future have no sales yet: the end is capped at yesterday", () => {
    expect(resolveRange({ from: "2026-11-01", to: "2026-11-30" }, TODAY).to).toBe("2026-11-05");
    expect(resolveRange({ from: "2026-11-06", to: "2027-01-01" }, TODAY)).toMatchObject({ from: "2026-11-05", to: "2026-11-05", days: 1 });
  });
  it("ignores malformed dates and swaps nothing silently: an inverted range collapses to a single day", () => {
    expect(resolveRange({ from: "nonsense", to: "2026-02-31" }, TODAY).to).toBe("2026-11-05");
    expect(resolveRange({ from: "2026-11-05", to: "2026-11-01" }, TODAY)).toMatchObject({ from: "2026-11-01", to: "2026-11-01" });
  });
  it("limits the range to what the database accepts (400 days) and says so", () => {
    const r = resolveRange({ from: "2020-01-01", to: "2026-11-05" }, TODAY);
    expect(r.days).toBe(MAX_RANGE_DAYS + 1);
    expect(r.clamped).toBe(true);
    expect(r.to).toBe("2026-11-05");
  });
  it("a range of exactly the maximum is not flagged", () => {
    expect(resolveRange({ from: "2025-10-02", to: "2026-11-05" }, TODAY).clamped).toBe(false);
  });
});
