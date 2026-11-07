import { Ionicons } from "@expo/vector-icons";
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, Text, TextInput, View, type StyleProp, type TextInputProps, type TextStyle, type ViewStyle } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useTheme } from "~/theme";

/** Comfortable touch targets: never smaller than 48 px. */
export const TOUCH = 48;

type Tone = "neutral" | "info" | "success" | "warning" | "danger";

export function Screen({ children, scroll = true, onRefresh, refreshing = false, footer, padded = true }: {
  children: React.ReactNode; scroll?: boolean; onRefresh?: () => void; refreshing?: boolean; footer?: React.ReactNode; padded?: boolean;
}) {
  const { colors } = useTheme();
  const body = scroll ? (
    <ScrollView
      contentContainerStyle={{ padding: padded ? 16 : 0, paddingBottom: 24, gap: 12 }}
      keyboardShouldPersistTaps="handled"
      refreshControl={onRefresh ? <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.action} /> : undefined}
    >{children}</ScrollView>
  ) : <View style={{ flex: 1, padding: padded ? 16 : 0, gap: 12 }}>{children}</View>;
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.bg }} edges={["top", "left", "right"]}>
      {body}
      {footer}
    </SafeAreaView>
  );
}

export function AppText({ variant = "body", tone, style, children, ...rest }: {
  variant?: "title" | "heading" | "body" | "small" | "num" | "numLarge"; tone?: "muted" | "action" | "danger" | "warning" | "success";
  style?: StyleProp<TextStyle>; children: React.ReactNode; numberOfLines?: number; accessibilityRole?: "header" | "text"; selectable?: boolean;
}) {
  const { colors } = useTheme();
  const sizes: Record<string, TextStyle> = {
    title: { fontSize: 26, fontWeight: "700", lineHeight: 32 },
    heading: { fontSize: 18, fontWeight: "600", lineHeight: 24 },
    body: { fontSize: 16, lineHeight: 22 },
    small: { fontSize: 14, lineHeight: 20 },
    num: { fontSize: 18, fontWeight: "600", fontVariant: ["tabular-nums"] },
    numLarge: { fontSize: 34, fontWeight: "700", fontVariant: ["tabular-nums"], lineHeight: 40 },
  };
  const color = tone === "muted" ? colors.muted : tone === "action" ? colors.action : tone === "danger" ? colors.danger : tone === "warning" ? colors.warning : tone === "success" ? colors.success : colors.text;
  return <Text style={[{ color }, sizes[variant], style]} {...rest}>{children}</Text>;
}

export function Card({ children, style, tone }: { children: React.ReactNode; style?: StyleProp<ViewStyle>; tone?: "mint" }) {
  const { colors } = useTheme();
  return (
    <View style={[{ backgroundColor: tone === "mint" ? colors.mint : colors.surface, borderColor: colors.border, borderWidth: 1, borderRadius: 20, padding: 16, gap: 8 }, style]}>
      {children}
    </View>
  );
}

export function Button({ title, onPress, variant = "primary", disabled, loading, style, accessibilityLabel, icon }: {
  title: string; onPress: () => void; variant?: "primary" | "secondary" | "ghost" | "danger"; disabled?: boolean; loading?: boolean;
  style?: StyleProp<ViewStyle>; accessibilityLabel?: string; icon?: keyof typeof Ionicons.glyphMap;
}) {
  const { colors } = useTheme();
  const bg = variant === "primary" ? colors.action : variant === "danger" ? colors.dangerSoft : variant === "secondary" ? colors.surface : "transparent";
  const fg = variant === "primary" ? colors.actionText : variant === "danger" ? colors.danger : colors.text;
  const off = disabled || loading;
  return (
    <Pressable
      accessibilityRole="button" accessibilityLabel={accessibilityLabel ?? title} accessibilityState={{ disabled: !!off, busy: !!loading }}
      disabled={off} onPress={onPress}
      style={({ pressed }) => [{
        minHeight: TOUCH + 4, borderRadius: 14, paddingHorizontal: 20, paddingVertical: 10, alignItems: "center", justifyContent: "center", flexDirection: "row", gap: 8,
        backgroundColor: bg, borderWidth: variant === "secondary" ? 1 : 0, borderColor: colors.border, opacity: off ? 0.5 : pressed ? 0.85 : 1, transform: [{ scale: pressed ? 0.985 : 1 }],
      }, style]}
    >
      {loading ? <ActivityIndicator color={fg} /> : icon ? <Ionicons name={icon} size={20} color={fg} /> : null}
      <Text style={{ color: fg, fontSize: 16, fontWeight: "600", textAlign: "center", flexShrink: 1 }}>{title}</Text>
    </Pressable>
  );
}

const toneIcon: Record<Tone, keyof typeof Ionicons.glyphMap> = {
  neutral: "information-circle", info: "information-circle", success: "checkmark-circle", warning: "warning", danger: "close-circle",
};

export function Notice({ tone = "info", children, style }: { tone?: Tone; children: React.ReactNode; style?: StyleProp<ViewStyle> }) {
  const { colors } = useTheme();
  const bg = { neutral: colors.surfaceSoft, info: colors.infoSoft, success: colors.successSoft, warning: colors.warningSoft, danger: colors.dangerSoft }[tone];
  const fg = { neutral: colors.text, info: colors.info, success: colors.success, warning: colors.warning, danger: colors.danger }[tone];
  return (
    <View
      accessibilityRole={tone === "danger" || tone === "warning" ? "alert" : undefined} accessibilityLiveRegion="polite"
      style={[{ backgroundColor: bg, borderRadius: 14, padding: 14, flexDirection: "row", gap: 10, alignItems: "flex-start" }, style]}
    >
      <Ionicons name={toneIcon[tone]} size={20} color={fg} style={{ marginTop: 1 }} />
      <View style={{ flex: 1, gap: 6 }}>{typeof children === "string" ? <Text style={{ color: fg, fontSize: 15, lineHeight: 21 }}>{children}</Text> : children}</View>
    </View>
  );
}

export function Badge({ tone = "neutral", children }: { tone?: Tone; children: string }) {
  const { colors } = useTheme();
  const bg = { neutral: colors.surfaceSoft, info: colors.infoSoft, success: colors.successSoft, warning: colors.warningSoft, danger: colors.dangerSoft }[tone];
  const fg = { neutral: colors.muted, info: colors.info, success: colors.success, warning: colors.warning, danger: colors.danger }[tone];
  return <View style={{ backgroundColor: bg, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 4, alignSelf: "flex-start" }}><Text style={{ color: fg, fontSize: 13, fontWeight: "600" }}>{children}</Text></View>;
}

export function Field({ label, error, style, ...input }: TextInputProps & { label: string; error?: string | null; style?: StyleProp<ViewStyle> }) {
  const { colors } = useTheme();
  return (
    <View style={[{ gap: 6 }, style]}>
      <Text style={{ color: colors.text, fontSize: 15, fontWeight: "600" }}>{label}</Text>
      <TextInput
        accessibilityLabel={label} placeholderTextColor={colors.muted}
        style={{
          minHeight: TOUCH + 4, borderRadius: 14, borderWidth: 1.5, borderColor: error ? colors.danger : colors.border, backgroundColor: colors.surface,
          color: colors.text, paddingHorizontal: 14, fontSize: 17,
        }}
        {...input}
      />
      {error ? <Text accessibilityRole="alert" style={{ color: colors.danger, fontSize: 14 }}>{error}</Text> : null}
    </View>
  );
}

export function Row({ children, style }: { children: React.ReactNode; style?: StyleProp<ViewStyle> }) {
  return <View style={[{ flexDirection: "row", alignItems: "center", gap: 8 }, style]}>{children}</View>;
}

export function Divider() {
  const { colors } = useTheme();
  return <View style={{ height: 1, backgroundColor: colors.border }} />;
}
