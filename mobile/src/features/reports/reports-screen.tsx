import { useRouter } from "expo-router";
import { useCallback, useMemo } from "react";
import { ActivityIndicator, Pressable, View } from "react-native";
import { formatBusinessDate, formatMonth } from "@/lib/dates/business";
import { formatLkr } from "@/lib/formatting/money";
import { useI18n } from "~/i18n";
import { api } from "~/lib/api";
import { useCachedLoad } from "~/lib/use-cached-load";
import { useSession } from "~/providers/session";
import { useSync } from "~/providers/sync";
import { useTheme } from "~/theme";
import { AppText, Badge, Card, Notice, Row, Screen, TOUCH } from "~/ui";
import { BarChart } from "~/ui/bar-chart";
import { whenText } from "~/lib/when";

const TREND_MONTHS = 6;
const statusTone = { complete: "success", pending: "warning", in_progress: "info" } as const;

/** The monthly reports (newest first), a six-month trend, and the most recent confirmed counts. Read-only, any role. */
export function ReportsScreen() {
  const { t, locale } = useI18n();
  const { colors } = useTheme();
  const router = useRouter();
  const { shop } = useSession();
  const { confirmedRevision } = useSync();
  const shopId = shop!.shopId;
  const loader = useCallback(() => api.reports(shopId), [shopId]);
  const { data, savedAt, loading, failed, refresh } = useCachedLoad(`cache.reports.${shopId}`, loader, confirmedRevision);

  // Oldest to newest, so the chart reads left to right like a calendar.
  const trend = useMemo(() => (data?.months ?? []).slice(0, TREND_MONTHS).reverse(), [data]);
  const peak = trend.reduce<{ month: string; amount: number } | null>((b, m) => (m.estimatedSales !== null && Number(m.estimatedSales) > (b?.amount ?? 0) ? { month: m.month, amount: Number(m.estimatedSales) } : b), null);

  return (
    <Screen onRefresh={() => void refresh()} refreshing={loading && !!data}>
      <AppText variant="title" accessibilityRole="header">{t("m.reports.title")}</AppText>
      {loading && !data ? <ActivityIndicator color={colors.action} style={{ padding: 24 }} /> : null}
      {!loading && !data ? <Notice tone="warning">{t("m.reports.noCache")}</Notice> : null}
      {savedAt !== null ? <Notice tone="info">{`${t("m.reports.offline")} (${whenText(savedAt, t)})`}</Notice> : null}
      {failed && savedAt === null && data ? <Notice tone="warning">{t("m.reports.offline")}</Notice> : null}

      {data ? (
        <>
          <Card>
            <AppText variant="heading">{t("m.reports.trend")}</AppText>
            {peak ? (
              <>
                <BarChart
                  points={trend.map((m) => ({ key: m.month, amount: m.estimatedSales === null ? null : Number(m.estimatedSales) }))}
                  summary={`${t("m.reports.trend")}. ${t("m.reports.peakMonth", { month: formatMonth(peak.month, locale), amount: formatLkr(peak.amount) })}`}
                />
                <Row style={{ justifyContent: "space-between" }}>
                  <AppText variant="small" tone="muted">{formatMonth(trend[0].month, locale, "short")}</AppText>
                  <AppText variant="small" tone="muted">{formatMonth(trend[trend.length - 1].month, locale, "short")}</AppText>
                </Row>
                <AppText variant="small" tone="muted">{t("m.reports.peakMonth", { month: formatMonth(peak.month, locale), amount: formatLkr(peak.amount) })}</AppText>
              </>
            ) : <AppText tone="muted">{t("m.reports.noFigures")}</AppText>}
            <AppText variant="small" tone="muted">{t("sales.estimateNote")}</AppText>
          </Card>

          <AppText variant="heading">{t("m.reports.months")}</AppText>
          {data.months.map((m) => (
            <Pressable
              key={m.month} accessibilityRole="button" onPress={() => router.push(`/reports/${m.month}`)}
              accessibilityLabel={`${formatMonth(m.month, locale)}, ${m.estimatedSales === null ? t("rep.noFigures") : formatLkr(m.estimatedSales)}`}
              style={({ pressed }) => ({ opacity: pressed ? 0.85 : 1 })}
            >
              <Card style={{ minHeight: TOUCH + 16 }}>
                <Row style={{ justifyContent: "space-between", alignItems: "flex-start" }}>
                  <View style={{ flex: 1, gap: 6 }}>
                    <AppText variant="heading">{formatMonth(m.month, locale)}</AppText>
                    <Row style={{ flexWrap: "wrap" }}>
                      <Badge tone={statusTone[m.status]}>
                        {m.status === "pending" ? t("rep.waiting", { date: formatBusinessDate(m.waitingFor ?? "", locale, { day: "numeric", month: "short" }) }) : t(`rep.status.${m.status}` as const)}
                      </Badge>
                      {m.recalculated ? <Badge tone="info">{t("rep.badge.recalculated")}</Badge> : null}
                    </Row>
                  </View>
                  <View style={{ alignItems: "flex-end" }}>
                    <AppText variant="num">{m.estimatedSales === null ? "—" : formatLkr(m.estimatedSales)}</AppText>
                    <AppText variant="small" tone="muted">{m.estimatedSales === null ? t("rep.noFigures") : t("common.estimated")}</AppText>
                  </View>
                </Row>
              </Card>
            </Pressable>
          ))}

          <AppText variant="heading">{t("m.reports.recent")}</AppText>
          {data.recent.length === 0 ? <AppText tone="muted">{t("m.reports.noRecent")}</AppText> : (
            <Card>
              {data.recent.map((r, i) => (
                <View key={r.id} style={{ gap: 2, paddingTop: i === 0 ? 0 : 10, borderTopWidth: i === 0 ? 0 : 1, borderTopColor: colors.border }}>
                  <Row style={{ justifyContent: "space-between" }}>
                    <AppText style={{ fontWeight: "600" }}>{formatBusinessDate(r.businessDate, locale)}</AppText>
                    <Badge tone={r.status === "corrected" ? "info" : "success"}>{r.status === "corrected" ? t("ms.status.corrected") : t("ms.status.confirmed")}</Badge>
                  </Row>
                  <AppText variant="small" tone="muted">
                    {t("m.reports.counted", { counted: r.counted, notCounted: r.notCounted })}{r.by ? ` · ${t("m.reports.by", { name: r.by })}` : ""}
                  </AppText>
                </View>
              ))}
            </Card>
          )}
        </>
      ) : null}
    </Screen>
  );
}
