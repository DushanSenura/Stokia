// @vitest-environment node
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import manifest from "@/app/manifest";

const root = path.resolve(__dirname, "../..");
const png = (rel: string) => {
  const buf = fs.readFileSync(path.join(root, "public", rel));
  expect(buf.subarray(1, 4).toString()).toBe("PNG");
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
};

describe("web app manifest", () => {
  const m = manifest();

  it("is installable: name, standalone display, start page, scope and theme", () => {
    expect(m).toMatchObject({ short_name: "Stokia", display: "standalone", scope: "/", start_url: "/dashboard", background_color: "#F8FAF8" });
    expect(m.name).toContain("Stokia");
    expect(m.theme_color).toMatch(/^#[0-9a-f]{6}$/i);
  });

  it("declares 192 and 512 icons plus a maskable one, and every declared file exists at exactly that size", () => {
    const icons = m.icons ?? [];
    const sizes = icons.filter((i) => i.purpose === "any").map((i) => i.sizes);
    expect(sizes).toEqual(expect.arrayContaining(["192x192", "512x512"]));
    expect(icons.some((i) => i.purpose === "maskable")).toBe(true);
    for (const i of icons) {
      const { width, height } = png(i.src.replace(/^\//, ""));
      expect(`${width}x${height}`).toBe(i.sizes);
    }
  });

  it("the shortcut opens the morning stock count", () => {
    expect(m.shortcuts?.[0]).toMatchObject({ url: "/morning-stock" });
  });
});

describe("assets the app shell depends on", () => {
  it("has the iPhone home-screen icon at 180x180", () => {
    expect(png("icons/apple-touch-icon.png")).toEqual({ width: 180, height: 180 });
  });

  it("ships a self-contained offline page (no scripts, English and Sinhala) and the service worker", () => {
    const html = fs.readFileSync(path.join(root, "public/offline.html"), "utf8");
    expect(html).not.toMatch(/<script/i);
    expect(html).toContain("You are offline");
    expect(html).toMatch(/[඀-෿]/); // Sinhala text present
    expect(fs.existsSync(path.join(root, "public/sw.js"))).toBe(true);
  });
});
