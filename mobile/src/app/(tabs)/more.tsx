import Constants from "expo-constants";
import { View } from "react-native";
import { LOCALE_LABELS, LOCALES, type MessageKey } from "@/i18n";
import { SyncBanner } from "~/features/sync/sync-banner";
import { useI18n } from "~/i18n";
import { useSession } from "~/providers/session";
import { useSync } from "~/providers/sync";
import { useTheme, type ThemePref } from "~/theme";
import { AppText, Button, Card, Divider, Row, Screen } from "~/ui";
import { confirmDialog } from "~/ui/confirm";

const THEMES: { pref: ThemePref; label: MessageKey }[] = [
  { pref: "system", label: "common.themeSystem" }, { pref: "light", label: "common.themeLight" }, { pref: "dark", label: "common.themeDark" },
];

/** Account, language, appearance, what is waiting to be sent, and sign out. */
export default function More() {
  const { t, locale, setLocale } = useI18n();
  const { pref, setPref } = useTheme();
  const { shop, user, signOut } = useSession();
  const { entries } = useSync();

  const confirmSignOut = async () => {
    // Counts waiting to be sent exist only on this phone: signing out deletes them, so say so.
    const message = entries.length > 0 ? t("sync.signOutWarning", { count: entries.length }) : t("m.more.signOutTitle");
    if (await confirmDialog(t("common.signOut"), message, t("common.signOut"), t("common.cancel"))) await signOut();
  };

  return (
    <Screen>
      <AppText variant="title" accessibilityRole="header">{t("m.tab.more")}</AppText>

      <Card>
        <AppText variant="heading">{t("m.more.account")}</AppText>
        <Info label={t("m.more.account")} value={`${user!.displayName}${user!.email ? ` · ${user!.email}` : ""}`} />
        <Divider />
        <Info label={t("m.more.shop")} value={shop!.shopName} />
        <Info label={t("m.more.role")} value={t(`common.role.${shop!.role}` as MessageKey)} />
      </Card>

      <Card>
        <AppText variant="heading">{t("common.language")}</AppText>
        <Row style={{ flexWrap: "wrap" }}>
          {LOCALES.map((l) => <Choice key={l} label={LOCALE_LABELS[l]} active={locale === l} onPress={() => setLocale(l)} />)}
        </Row>
        <AppText variant="heading" style={{ marginTop: 8 }}>{t("m.more.appearance")}</AppText>
        <Row style={{ flexWrap: "wrap" }}>
          {THEMES.map((o) => <Choice key={o.pref} label={t(o.label)} active={pref === o.pref} onPress={() => setPref(o.pref)} />)}
        </Row>
      </Card>

      <Card>
        <AppText variant="heading">{t("m.more.sync")}</AppText>
        {entries.length === 0 ? <AppText tone="muted">{t("m.more.syncNone")}</AppText> : null}
        <SyncBanner />
      </Card>

      <Button title={t("common.signOut")} variant="secondary" icon="log-out-outline" onPress={() => void confirmSignOut()} />
      <AppText variant="small" tone="muted" style={{ textAlign: "center" }}>{t("m.more.version", { version: Constants.expoConfig?.version ?? "" })}</AppText>
    </Screen>
  );
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <View accessible accessibilityLabel={`${label}: ${value}`} style={{ gap: 2 }}>
      <AppText variant="small" tone="muted">{label}</AppText>
      <AppText>{value}</AppText>
    </View>
  );
}

function Choice({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  return <Button title={label} variant={active ? "primary" : "secondary"} onPress={onPress} style={{ minHeight: 48 }} accessibilityLabel={label} />;
}
