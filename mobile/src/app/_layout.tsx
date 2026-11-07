import "~/lib/polyfills";
import { Stack } from "expo-router";
import { ActivityIndicator, View } from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { I18nProvider, useI18n } from "~/i18n";
import { SessionProvider, useSession } from "~/providers/session";
import { ThemeProvider, useTheme } from "~/theme";
import { AppText, Button, Notice } from "~/ui";

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <ThemeProvider>
        <I18nProvider>
          <SessionProvider>
            <Gate />
          </SessionProvider>
        </I18nProvider>
      </ThemeProvider>
    </SafeAreaProvider>
  );
}

/** Sign-in gate: signed-out people can only reach the sign-in screens; signed-in people can only reach the app. */
function Gate() {
  const { status } = useSession();
  const { colors } = useTheme();
  if (status === "loading") {
    return <View style={{ flex: 1, backgroundColor: colors.bg, alignItems: "center", justifyContent: "center" }}><ActivityIndicator size="large" color={colors.action} /></View>;
  }
  if (status === "problem") return <Problem />;
  return (
    <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.bg } }}>
      <Stack.Protected guard={status === "ready"}>
        <Stack.Screen name="(tabs)" />
      </Stack.Protected>
      <Stack.Protected guard={status === "signedOut"}>
        <Stack.Screen name="sign-in" />
        <Stack.Screen name="reset-password" />
      </Stack.Protected>
    </Stack>
  );
}

/** Signed in, but cannot continue: not part of any shop yet, or the profile cannot be loaded and nothing is saved on the phone. */
function Problem() {
  const { t } = useI18n();
  const { colors } = useTheme();
  const { problem, reload, signOut } = useSession();
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.bg }}>
      <View style={{ flex: 1, padding: 24, gap: 14, justifyContent: "center" }}>
        <AppText variant="title" accessibilityRole="header">{t("brand.name")}</AppText>
        <Notice tone="warning">{problem === "noShop" ? t("m.signin.noShop") : t("m.signin.loadFailed")}</Notice>
        {problem === "unreachable" ? <Button title={t("common.retry")} onPress={() => void reload()} /> : null}
        <Button title={t("common.signOut")} variant="secondary" onPress={() => void signOut()} />
      </View>
    </SafeAreaView>
  );
}
