import { describe, expect, it } from "vitest";
import { createTranslator } from "@/i18n";
import { en } from "@/i18n/en";
import { si } from "@/i18n/si";

describe("i18n", () => {
  it("returns English strings and interpolates variables", () => {
    expect(createTranslator("en")("dash.greeting", { name: "Nimal" })).toBe("Hello, Nimal");
  });
  it("returns Sinhala when available", () => {
    expect(createTranslator("si")("nav.dashboard")).toBe("උපකරණ පුවරුව");
  });
  it("falls back to English for untranslated keys", () => {
    expect(createTranslator("si")("audit.subtitle")).toBe(en["audit.subtitle"]);
  });
  it("Sinhala has no keys that English lacks", () => {
    for (const k of Object.keys(si)) expect(k in en).toBe(true);
  });
  it("preserves placeholders in Sinhala strings", () => {
    for (const [k, v] of Object.entries(si)) {
      const ph = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort().join();
      expect(ph(v as string)).toBe(ph(en[k as keyof typeof en]));
    }
  });
});

describe("Sinhala coverage of the key daily workflows", () => {
  // Navigation, sign-in, shop setup, the whole morning-stock flow, the dashboard's morning card and KPIs, movements, and settings navigation.
  const CORE = ["nav.", "common.", "auth.", "setup.", "ms.", "mv.type.", "mv.title", "mv.record", "mv.repack", "dash.kpi.", "dash.enterMorning", "dash.morning.", "dash.state.",
    "sh.title", "set.nav.", "set.title", "team.role.", "team.status.", "rep.title", "rep.status.", "an.title", "error."];
  const core = Object.keys(en).filter((k) => CORE.some((p) => k.startsWith(p)));

  it("every core-workflow string has a Sinhala translation", () => {
    const missing = core.filter((k) => !(k in si));
    expect(missing).toEqual([]);
  });
  it("Sinhala strings are real Sinhala (not copies of the English), except brand names", () => {
    const sinhala = /[඀-෿]/;
    const notSinhala = core.filter((k) => !sinhala.test((si as Record<string, string>)[k] ?? "") && !["common.themeSystem"].includes(k));
    expect(notSinhala).toEqual([]);
  });
  it("translations keep every placeholder the English string has", () => {
    for (const k of core) {
      const ph = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort().join();
      expect(ph((si as Record<string, string>)[k]), k).toBe(ph((en as Record<string, string>)[k]));
    }
  });
  it("the Sinhala dictionary has no stray keys and no empty strings", () => {
    for (const [k, v] of Object.entries(si)) { expect(k in en, k).toBe(true); expect((v as string).trim().length, k).toBeGreaterThan(0); }
  });
  it("an untranslated (non-core) key still falls back to English instead of showing a key", () => {
    expect(createTranslator("si")("audit.subtitle")).toBe(en["audit.subtitle"]);
  });
});
