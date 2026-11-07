import * as Device from "expo-device";
import { Platform } from "react-native";

/** A short, human label for the audit trail ("Google Pixel 7 (Stokia app)"). Never anything that identifies the person. */
export function deviceLabel(): string {
  const name = [Device.manufacturer, Device.modelName].filter(Boolean).join(" ") || (Platform.OS === "web" ? "browser test build" : Platform.OS);
  return `${name} (Stokia app)`.slice(0, 100);
}
