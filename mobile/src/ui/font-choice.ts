import type { TextStyle } from "react-native";

// Pure (no font files imported), so it can be unit-tested. See fonts.ts for the font files themselves.
// A native custom font has one family name per weight, so a weight is chosen by family, not by `fontWeight`.

export type Weight = "regular" | "semibold" | "bold";

/** CSS-style weight (400, "600", "bold", ...) to one of the three weights the app bundles. */
export function weightOf(w: TextStyle["fontWeight"] | undefined): Weight {
  if (w === undefined || w === "normal") return "regular";
  const n = w === "bold" ? 700 : Number(w);
  if (!Number.isFinite(n) || n < 600) return "regular";
  return n >= 700 ? "bold" : "semibold";
}

const SUFFIX: Record<Weight, string> = { regular: "400Regular", semibold: "600SemiBold", bold: "700Bold" };

/** The bundled family name for a language and weight (Inter for English, Noto Sans Sinhala for Sinhala). */
export const fontFamilyFor = (locale: "en" | "si", weight: Weight): string => `${locale === "si" ? "NotoSansSinhala" : "Inter"}_${SUFFIX[weight]}`;

/** The style to put on any Text / TextInput that is not an AppText. */
export const fontStyle = (locale: "en" | "si", w?: TextStyle["fontWeight"]): Pick<TextStyle, "fontFamily"> => ({ fontFamily: fontFamilyFor(locale, weightOf(w)) });
