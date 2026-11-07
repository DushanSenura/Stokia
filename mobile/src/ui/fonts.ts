import { Inter_400Regular, Inter_600SemiBold, Inter_700Bold } from "@expo-google-fonts/inter";
import { NotoSansSinhala_400Regular, NotoSansSinhala_600SemiBold, NotoSansSinhala_700Bold } from "@expo-google-fonts/noto-sans-sinhala";
import { useFonts } from "expo-font";
import { useEffect, useState } from "react";

export { fontFamilyFor, fontStyle, weightOf, type Weight } from "./font-choice";

/**
 * The web app's own typefaces: Inter for English, Noto Sans Sinhala for Sinhala. They are bundled in the app (no download at run time),
 * so Sinhala letters look the same on every phone instead of depending on whatever the phone happens to ship with.
 */
export const FONT_ASSETS = {
  Inter_400Regular, Inter_600SemiBold, Inter_700Bold,
  NotoSansSinhala_400Regular, NotoSansSinhala_600SemiBold, NotoSansSinhala_700Bold,
};

/**
 * True once the fonts are loaded, or have failed, or 4 seconds have passed: a font problem must never keep anyone out of the app
 * (text then simply uses the phone's own font).
 */
export function useFontsReady(): boolean {
  const [loaded, error] = useFonts(FONT_ASSETS);
  const [gaveUp, setGaveUp] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setGaveUp(true), 4000);
    return () => clearTimeout(t);
  }, []);
  return loaded || Boolean(error) || gaveUp;
}
