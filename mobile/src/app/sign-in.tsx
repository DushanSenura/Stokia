import { Link } from "expo-router";
import { useState } from "react";
import { Image, KeyboardAvoidingView, Platform, ScrollView, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useI18n } from "~/i18n";
import type { Key } from "~/i18n";
import { isConfigured } from "~/lib/config";
import { useSession } from "~/providers/session";
import { useTheme } from "~/theme";
import { AppText, Button, Field, Notice } from "~/ui";

export default function SignIn() {
  const { t, locale, setLocale } = useI18n();
  const { colors } = useTheme();
  const { signIn } = useSession();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Key | null>(null);
  const [fieldError, setFieldError] = useState<{ email?: boolean; password?: boolean }>({});

  const submit = async () => {
    const bad = { email: !/^\S+@\S+\.\S+$/.test(email.trim()), password: password.length === 0 };
    setFieldError(bad);
    if (bad.email || bad.password) { setError(null); return; }
    setBusy(true); setError(null);
    const r = await signIn(email, password);
    if (!r.ok) setError(r.error);
    setBusy(false);
  };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.bg }}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <ScrollView contentContainerStyle={{ padding: 24, gap: 16, flexGrow: 1, justifyContent: "center" }} keyboardShouldPersistTaps="handled">
          <View style={{ alignItems: "center", gap: 8 }}>
            <Image source={require("../../assets/images/icon.png")} style={{ width: 88, height: 88, borderRadius: 20 }} accessibilityLabel={t("brand.name")} />
            <AppText variant="title" accessibilityRole="header">{t("auth.login.title")}</AppText>
            <AppText tone="muted" style={{ textAlign: "center" }}>{t("brand.tagline")}</AppText>
          </View>

          {!isConfigured ? <Notice tone="warning">{t("m.notConfigured")}</Notice> : null}
          {error ? <Notice tone="danger">{t(error)}</Notice> : null}

          <Field
            label={t("auth.email")} value={email} onChangeText={setEmail} autoCapitalize="none" autoComplete="email" keyboardType="email-address" textContentType="emailAddress"
            error={fieldError.email ? t("auth.error.email") : null} returnKeyType="next"
          />
          <Field
            label={t("auth.password")} value={password} onChangeText={setPassword} secureTextEntry autoComplete="current-password" textContentType="password"
            error={fieldError.password ? t("auth.error.passwordRequired") : null} returnKeyType="go" onSubmitEditing={() => void submit()}
          />
          <Button title={busy ? t("m.signin.signingIn") : t("common.signIn")} onPress={() => void submit()} loading={busy} disabled={!isConfigured} />
          <Link href="/reset-password" style={{ color: colors.action, fontSize: 16, textAlign: "center", paddingVertical: 12 }} accessibilityRole="link">{t("auth.forgot")}</Link>
          <Button title={locale === "en" ? "සිංහල" : "English"} variant="ghost" onPress={() => setLocale(locale === "en" ? "si" : "en")} accessibilityLabel={t("common.language")} />
          <AppText variant="small" tone="muted" style={{ textAlign: "center" }}>{t("auth.invitationOnly")}</AppText>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
