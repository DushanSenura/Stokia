import { Stack } from "expo-router";
import { useTheme } from "~/theme";

/** The More tab holds its own small stack: the settings page, and Stock movements (reached from Home too, so it is not a sixth tab). */
export default function MoreLayout() {
  const { colors } = useTheme();
  return <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.bg } }} />;
}
