import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { fontFamilyFor, fontStyle, weightOf } from "../../mobile/src/ui/font-choice";

describe("phone fonts", () => {
  it("maps a CSS weight to one of the three bundled weights", () => {
    expect(weightOf(undefined)).toBe("regular");
    expect(weightOf("normal")).toBe("regular");
    expect(weightOf("400")).toBe("regular");
    expect(weightOf("500")).toBe("regular");
    expect(weightOf("600")).toBe("semibold");
    expect(weightOf("700")).toBe("bold");
    expect(weightOf("bold")).toBe("bold");
    expect(weightOf(800)).toBe("bold");
    expect(weightOf("nonsense" as never)).toBe("regular");
  });

  it("uses Inter for English and Noto Sans Sinhala for Sinhala", () => {
    expect(fontFamilyFor("en", "regular")).toBe("Inter_400Regular");
    expect(fontFamilyFor("en", "semibold")).toBe("Inter_600SemiBold");
    expect(fontFamilyFor("si", "bold")).toBe("NotoSansSinhala_700Bold");
    expect(fontStyle("si", "600")).toEqual({ fontFamily: "NotoSansSinhala_600SemiBold" });
    expect(fontStyle("en")).toEqual({ fontFamily: "Inter_400Regular" });
  });

  // The phone's own packages are not installed by the web project, so read their export lists from disk; skipped where they are absent.
  const pkg = (name: string) => path.resolve(__dirname, "../../mobile/node_modules/@expo-google-fonts", name, "index.js");
  it.skipIf(!fs.existsSync(pkg("inter")) || !fs.existsSync(pkg("noto-sans-sinhala")))("every family it can ask for is one the app bundles", () => {
    const exported = fs.readFileSync(pkg("inter"), "utf8") + fs.readFileSync(pkg("noto-sans-sinhala"), "utf8");
    for (const locale of ["en", "si"] as const) for (const w of ["regular", "semibold", "bold"] as const) {
      expect(exported.includes(fontFamilyFor(locale, w)), fontFamilyFor(locale, w)).toBe(true);
    }
  });
});
