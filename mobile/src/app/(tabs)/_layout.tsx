import { Ionicons } from "@expo/vector-icons";
import { Tabs } from "expo-router/js-tabs";
import { useI18n } from "~/i18n";
import { SyncProvider } from "~/providers/sync";
import { useSession } from "~/providers/session";
import { useTheme } from "~/theme";

/** The three working tabs. The offline queue lives here, so it runs whenever the person is signed in and inside the app. */
export default function TabsLayout() {
  const { t } = useI18n();
  const { colors } = useTheme();
  const { shop, user } = useSession();
  return (
    <SyncProvider scope={`${shop!.shopId}:${user!.id}`}>
      <Tabs
        screenOptions={{
          headerShown: false,
          tabBarActiveTintColor: colors.action,
          tabBarInactiveTintColor: colors.muted,
          tabBarStyle: { backgroundColor: colors.surface, borderTopColor: colors.border, minHeight: 60 },
          tabBarLabelStyle: { fontSize: 12, fontWeight: "600", paddingBottom: 4 },
          tabBarItemStyle: { minHeight: 56 },
        }}
      >
        <Tabs.Screen name="index" options={{ title: t("m.tab.home"), tabBarIcon: ({ color, size }) => <Ionicons name="home-outline" size={size} color={String(color)} /> }} />
        {/* Five tabs leave little room: a short label on screen, the full name for screen readers. */}
        <Tabs.Screen name="stock" options={{ title: t("m.tab.stock"), tabBarLabel: t("m.tab.stockShort"), tabBarAccessibilityLabel: t("m.tab.stock"), tabBarIcon: ({ color, size }) => <Ionicons name="clipboard-outline" size={size} color={String(color)} /> }} />
        <Tabs.Screen name="products" options={{ title: t("m.tab.products"), tabBarIcon: ({ color, size }) => <Ionicons name="cube-outline" size={size} color={String(color)} /> }} />
        <Tabs.Screen name="reports" options={{ title: t("m.tab.reports"), tabBarIcon: ({ color, size }) => <Ionicons name="bar-chart-outline" size={size} color={String(color)} /> }} />
        <Tabs.Screen name="more" options={{ title: t("m.tab.more"), tabBarIcon: ({ color, size }) => <Ionicons name="ellipsis-horizontal-circle-outline" size={size} color={String(color)} /> }} />
      </Tabs>
    </SyncProvider>
  );
}
