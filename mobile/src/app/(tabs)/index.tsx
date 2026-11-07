import { useRouter } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, View } from "react-native";
import { formatBusinessDate } from "@/lib/dates/business";
import { formatLkr } from "@/lib/formatting/money";
import { SyncBanner } from "~/features/sync/sync-banner";
import { useI18n } from "~/i18n";
import { api } from "~/lib/api";
import { ApiSignedOut, type HomeResponse } from "~/lib/api-client";
import { kvGetJson, kvSetJson } from "~/lib/kv";
import { whenText } from "~/lib/when";
import { useSession } from "~/providers/session";
import { useSync } from "~/providers/sync";
import { useTheme } from "~/theme";
import { AppText, Badge, Button, Card, Notice, Row, Screen } from "~/ui";

interface Saved { data: HomeResponse; savedAt: number }

/** Today at a glance: is this morning's count done, and what did the shop (estimate to) sell yesterday. */
export default function Home() {
  const { t, locale } = useI18n();
  const { colors } = useTheme();
  const router = useRouter();
  const { shop, user, signOut } = useSession();
  const { confirmedRevision } = useSync();
  const shopId = shop!.shopId;
  const [data, setData] = useState<HomeResponse | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null); // set only when showing the copy saved on the phone
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    try {
      const d = await api.home(shopId);
      setData(d); setSavedAt(null); setFailed(false);
      await kvSetJson(`cache.home.${shopId}`, { data: d, savedAt: Date.now() } satisfies Saved);
    } catch (e) {
      if (e instanceof ApiSignedOut) { await signOut(); return; }
      const saved = await kvGetJson<Saved>(`cache.home.${shopId}`);
      if (saved) { setData(saved.data); setSavedAt(saved.savedAt); }
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }, [shopId, signOut]);

  useEffect(() => {
    let live = true;
    void (async () => { if (live) await load(); })();
    return () => { live = false; };
  }, [load, confirmedRevision]);
  /** Pull-to-refresh: show the spinner, then load. */
  const refresh = useCallback(() => { setLoading(true); return load(); }, [load]);

  const status = data?.todayStatus;
  const statusLabel = status === "confirmed" ? t("ms.status.confirmed") : status === "draft" ? t("ms.status.draft") : t("ms.status.notStarted");
  const sales = data?.sales ?? null;

  return (
    <Screen onRefresh={() => void refresh()} refreshing={loading && !!data}>
      <View>
        <AppText variant="title" accessibilityRole="header">{t("m.home.title")}</AppText>
        <AppText tone="muted">{shop!.shopName} · {user!.displayName}</AppText>
      </View>

      <SyncBanner />

      {loading && !data ? <ActivityIndicator color={colors.action} style={{ padding: 24 }} /> : null}
      {!loading && !data ? <Notice tone="warning">{t("m.home.noCache")}</Notice> : null}
      {savedAt !== null ? <Notice tone="info">{t("m.home.cached", { when: whenText(savedAt, t) })}</Notice> : null}
      {failed && savedAt === null ? <Notice tone="warning">{t("m.home.refreshFailed")}</Notice> : null}

      {data ? (
        <>
          <Card>
            <Row style={{ justifyContent: "space-between" }}>
              <AppText variant="heading">{t("m.home.todayCount")}</AppText>
              <Badge tone={status === "confirmed" ? "success" : status === "draft" ? "info" : "neutral"}>{statusLabel}</Badge>
            </Row>
            <AppText variant="small" tone="muted">{t("ms.countDate", { date: formatBusinessDate(data.today, locale) })}</AppText>
            {status === "confirmed"
              ? <AppText tone="success">{t("m.home.confirmedToday")}</AppText>
              : <Button title={status === "draft" ? t("m.home.continue") : t("m.home.enter")} icon="clipboard-outline" onPress={() => router.navigate("/stock")} />}
          </Card>

          {sales && data.salesDate ? (
            <Card tone="mint">
              <AppText variant="small" tone="muted">{t("m.home.salesFor", { date: formatBusinessDate(data.salesDate, locale) })}</AppText>
              <AppText variant="numLarge" tone="action">{formatLkr(sales.estimatedTotal)}</AppText>
              <Badge tone="neutral">{t("common.estimated")}</Badge>
              {Object.keys(sales.unitsByBaseUnit).length > 0 ? (
                <View style={{ gap: 2 }}>
                  <AppText variant="small" tone="muted">{t("m.home.unitsSold")}</AppText>
                  {/* Units of different kinds are never added together: one line per unit. */}
                  {Object.entries(sales.unitsByBaseUnit).map(([unit, qty]) => <AppText key={unit} variant="num">{`${qty} ${unit}`}</AppText>)}
                </View>
              ) : null}
              {sales.needsReview > 0 ? <AppText variant="small" tone="warning">{t("ms.successReview", { count: sales.needsReview })}</AppText> : null}
              {sales.pending > 0 ? <AppText variant="small" tone="muted">{t("ms.successPending", { count: sales.pending })}</AppText> : null}
              <AppText variant="small" tone="muted">{t("sales.estimateNote")}</AppText>
            </Card>
          ) : <Notice tone="info">{t("m.home.noSales")}</Notice>}
        </>
      ) : null}
    </Screen>
  );
}
