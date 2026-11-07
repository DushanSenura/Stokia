import { Stack } from "expo-router";
import { useTheme } from "~/theme";

/** The Reports tab holds its own small stack: the month list, then one month's report. */
export default function ReportsLayout() {
  const { colors } = useTheme();
  return <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.bg } }} />;
}
