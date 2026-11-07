import { describe, expect, it } from "vitest";
import { changedFields, KNOWN_ACTIONS, maskedJson } from "@/features/settings/audit";
import { CAPABILITIES, can, ROLE_RANK, ROLES, rolesFor, type Capability } from "@/server/permissions";

describe("permission matrix", () => {
  const caps = Object.keys(CAPABILITIES) as Capability[];

  it("owners can do everything; viewers can only read and export", () => {
    for (const c of caps) expect(can("owner", c), c).toBe(true);
    expect(caps.filter((c) => can("viewer", c)).sort()).toEqual(["data.read", "reports.export"]);
  });
  it("stock managers record counts and movements and request corrections, but cannot approve, manage people, or change settings", () => {
    expect(caps.filter((c) => can("stock_manager", c)).sort()).toEqual(["corrections.request", "data.read", "inventory.write", "reports.export"]);
  });
  it("is monotonic: a higher role never has less access than a lower one", () => {
    const sorted = [...ROLES].sort((a, b) => ROLE_RANK[a] - ROLE_RANK[b]);
    for (const c of caps) {
      let seen = false;
      for (const r of sorted) { if (can(r, c)) seen = true; else expect(seen, `${c}: ${r} lacks it but a lower role has it`).toBe(false); }
    }
  });
  it("denies unknown / missing roles", () => {
    expect(can(null, "data.read")).toBe(false);
    expect(can(undefined, "data.read")).toBe(false);
    expect(can("superadmin" as never, "data.read")).toBe(false);
  });
  it("rolesFor returns a copy (callers cannot widen access by mutating it)", () => {
    const r = rolesFor("catalog.write"); r.push("viewer");
    expect(rolesFor("catalog.write")).toEqual(["owner"]);
    expect(can("viewer", "catalog.write")).toBe(false);
  });
});

describe("audit helpers", () => {
  it("shows only what changed, ignoring timestamps and counters", () => {
    expect(changedFields({ name: "Perera Stores", timezone: "Asia/Colombo", updated_at: "a", revision: 1 }, { name: "Perera & Sons", timezone: "Asia/Colombo", updated_at: "b", revision: 2 }))
      .toEqual([{ field: "name", before: "Perera Stores", after: "Perera & Sons" }]);
  });
  it("for a new record every field is 'new' (before is a dash)", () => {
    expect(changedFields(null, { role: "viewer", status: "invited" })).toEqual([{ field: "role", before: "—", after: "viewer" }, { field: "status", before: "—", after: "invited" }]);
  });
  it("masks secret-looking fields everywhere (defence in depth), and truncates very long values", () => {
    expect(changedFields({ api_token: "abc" }, { api_token: "xyz" })).toEqual([{ field: "api_token", before: "••••", after: "••••" }]);
    expect(maskedJson({ ok: 1, password_hash: "x" })).toBe(JSON.stringify({ ok: 1, password_hash: "••••" }, null, 2));
    expect(changedFields({ note: "a" }, { note: "x".repeat(300) })[0].after.endsWith("…")).toBe(true);
    expect(maskedJson(null)).toBe("—");
  });
  it("lists correction actions among the known, translated action codes", () => {
    for (const a of ["request_correction", "apply_correction", "reject_correction", "confirm_count"]) expect(KNOWN_ACTIONS).toContain(a);
  });
});
