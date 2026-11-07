import { describe, expect, it } from "vitest";
import { createShopSchema, loginSchema, safeNextPath, updatePasswordSchema } from "@/server/validators/auth";

describe("safeNextPath (open-redirect protection)", () => {
  it("allows same-site relative paths", () => expect(safeNextPath("/products?x=1")).toBe("/products?x=1"));
  it.each(["//evil.com", "https://evil.com", String.raw`/\evil.com`, "javascript:alert(1)", undefined, 42])(
    "rejects %s", (v) => expect(safeNextPath(v)).toBe("/dashboard"));
});

describe("loginSchema", () => {
  it("normalises email", () =>
    expect(loginSchema.parse({ email: "  Owner@Shop.LK ", password: "x" }).email).toBe("owner@shop.lk"));
  it("rejects bad email / empty password", () => {
    expect(loginSchema.safeParse({ email: "nope", password: "x" }).success).toBe(false);
    expect(loginSchema.safeParse({ email: "a@b.lk", password: "" }).success).toBe(false);
  });
});

describe("updatePasswordSchema", () => {
  it("requires 10+ chars and a matching confirmation", () => {
    expect(updatePasswordSchema.safeParse({ password: "short", confirm: "short" }).success).toBe(false);
    expect(updatePasswordSchema.safeParse({ password: "longenough1", confirm: "different11" }).success).toBe(false);
    expect(updatePasswordSchema.safeParse({ password: "longenough1", confirm: "longenough1" }).success).toBe(true);
  });
});

describe("createShopSchema", () => {
  it("accepts a valid shop and defaults LKR", () => {
    const r = createShopSchema.parse({ name: " Perera Stores ", timezone: "Asia/Colombo" });
    expect(r).toMatchObject({ name: "Perera Stores", currency: "LKR" });
  });
  it("rejects short names and unknown timezones", () => {
    expect(createShopSchema.safeParse({ name: "A", timezone: "Asia/Colombo" }).success).toBe(false);
    expect(createShopSchema.safeParse({ name: "Shop", timezone: "Mars/Base" }).success).toBe(false);
  });
});
