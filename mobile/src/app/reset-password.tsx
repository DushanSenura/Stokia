import { Link } from "expo-router";
import { useState } from "react";
import { ScrollView } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useI18n } from "~/i18n";
import type { Key } from "~/i18n";
import { config } from "~/lib/config";
import { getSupabase } from "~/lib/supabase";
import { useTheme } from "~/theme";
import { AppText, Button, Field, Notice } from "~/ui";

/**
 * Password recovery: Supabase emails a link; the person chooses the new password in the web app (the same page the web sign-in
 * uses), so there is one recovery flow, not two. The answer is the same whether or not the address has an account.
 */
export default function ResetPassword() {
  const { t } = useI18n();
  const { colors } = useTheme();
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<Key | null>(null);

  const submit = async () => {
    if (!/^\S+@\S+\.\S+$/.test(email.trim())) { setError("auth.error.email"); return; }
    setBusy(true); setError(null);
    try {
      const { error: e } = await getSupabase().auth.resetPasswordForEmail(email.trim(), { redirectTo: `${config.siteUrl}/auth/callback?next=/update-password` });
      if (e && e.status === 429) setError("auth.error.rateLimit");
      else setSent(true); // never reveal whether the address has an account
    } catch {
      setError("m.signin.loadFailed");
    }
    setBusy(false);
  };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.bg }}>
      <ScrollView contentContainerStyle={{ padding: 24, gap: 16, flexGrow: 1, justifyContent: "center" }} keyboardShouldPersistTaps="handled">
        <AppText variant="title" accessibilityRole="header">{t("auth.reset.title")}</AppText>
        <AppText tone="muted">{t("m.reset.help")}</AppText>
        {sent ? <Notice tone="success">{t("auth.reset.sent")}</Notice> : (
          <>
            {error ? <Notice tone="danger">{t(error)}</Notice> : null}
            <Field label={t("auth.email")} value={email} onChangeText={setEmail} autoCapitalize="none" autoComplete="email" keyboardType="email-address" returnKeyType="send" onSubmitEditing={() => void submit()} />
            <Button title={t("auth.reset.send")} onPress={() => void submit()} loading={busy} />
          </>
        )}
        <Link href="/sign-in" style={{ color: colors.action, fontSize: 16, textAlign: "center", paddingVertical: 12 }} accessibilityRole="link">{t("auth.reset.back")}</Link>
      </ScrollView>
    </SafeAreaView>
  );
}
