import { View } from "react-native";
import { scaleBars, type BarInput } from "~/features/reports/chart";
import { useTheme } from "~/theme";

/**
 * A small bar chart that stays readable on a phone. It is announced to screen readers as ONE image with a plain-words summary (the
 * caller provides it), rather than as dozens of anonymous bars. A day with no figure draws a faint dot, never a bar.
 */
export function BarChart({ points, summary, height = 110 }: { points: BarInput[]; summary: string; height?: number }) {
  const { colors } = useTheme();
  const bars = scaleBars(points, height);
  const gap = bars.length > 20 ? 2 : 6;
  return (
    <View accessible accessibilityRole="image" accessibilityLabel={summary} style={{ height, flexDirection: "row", alignItems: "flex-end", gap }}>
      {bars.map((b) => (
        <View key={b.key} style={{ flex: 1, minWidth: 2, height, justifyContent: "flex-end" }}>
          {b.amount === null ? (
            <View style={{ height: 3, borderRadius: 2, backgroundColor: colors.border }} />
          ) : (
            <View style={{ height: Math.max(b.height, 2), borderTopLeftRadius: 4, borderTopRightRadius: 4, backgroundColor: b.height > 0 ? colors.primary : colors.border }} />
          )}
        </View>
      ))}
    </View>
  );
}
