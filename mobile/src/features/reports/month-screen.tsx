import { useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useMemo, useState } from "react";
import { ActivityIndicator, View } from "react-native";
import { noteSentence } from "@/features/reports/note-text";
import { formatBusinessDate, formatMonth, isMonth } from "@/lib/dates/business";
import { formatLkr } from "@/lib/formatting/money";
import type { MessageKey } from "@/i18n";
import { useI18n } from "~/i18n";
import { api } from "~/lib/api";
import { ApiForbidden, ApiSignedOut, type ReportFileFormat } from "~/lib/api-client";
import { shareFile } from "~/lib/share";
import { useCachedLoad } from "~/lib/use-cached-load";
import { whenText } from "~/lib/when";
import { useSession } from "~/providers/session";
import { useTheme } from "~/theme";
import { AppText, Badge, Button, Card, Divider, Notice, Row, Screen } from "~/ui";
import { BarChart } from "~/ui/bar-chart";
import { peakOf } from "./chart";

const num = (v: string) => Number(v).toLocaleString("en-US", { maximumFractionDigits: 3 });
const TOP = 10;
const statusTone = { complete: "success", pending: "warning", in_progress: "info" } as const;

/** One month's report: totals, the daily chart, best sellers, the stock summary, low stock, and sharing the file. */
export function MonthScreen() {
  const { month: raw } = useLocalSearchParams<{ month: string }>();
  const month = typeof raw === "string" && isMonth(raw) ? raw : null;
  return month ? <Month month={month} /> : <Missing />;
}

function Missing() {
  const { t } = useI18n();
  const router = useRouter();
  return (
    <Screen>
      <Notice tone="warning">{t("m.reports.monthNoCache")}</Notice>
      <Button title={t("m.reports.back")} variant="secondary" onPress={() => router.navigate("/reports")} />
    </Screen>
  );
}

function Month({ month }: { month: string }) {
  const { t, locale } = useI18n();
  const { colors } = useTheme();
  const router = useRouter();
  const { shop, signOut } = useSession();
  const shopId = shop!.shopId;
  const loader = useCallback(async () => (await api.report(shopId, month)).report, [shopId, month]);
  const { data: report, savedAt, loading, failed, refresh } = useCachedLoad(`cache.report.${shopId}.${month}`, loader);

  const [sharing, setSharing] = useState<ReportFileFormat | null>(null);
  const [shareError, setShareError] = useState<MessageKey | "m.reports.shareFailed" | "m.reports.shareUnavailable" | null>(null);

  const days = useMemo(() => (report?.daily ?? []).map((d) => ({ key: d.key, amount: d.amount })), [report]);
  const peak = peakOf(days);
  const figureDays = useMemo(() => days.filter((d) => d.amount !== null).length, [days]);
  const hasNote = (code: string) => !!report?.notes.some((n) => n.code === code);
  const best = useMemo(() => [...(report?.products ?? [])].filter((p) => Number(p.amount) > 0).sort((a, b) => Number(b.amount) - Number(a.amount)).slice(0, TOP), [report]);

  const share = async (format: ReportFileFormat) => {
    setSharing(format); setShareError(null);
    try {
      const file = await api.reportFile(shopId, month, format);
      if ((await shareFile(file)) === "unavailable") setShareError("m.reports.shareUnavailable");
    } catch (e) {
      if (e instanceof ApiSignedOut) { await signOut(); return; }
      setShareError(e instanceof ApiForbidden ? "error.forbidden" : "m.reports.shareFailed");
    } finally {
      setSharing(null);
    }
  };

  return (
    <Screen onRefresh={() => void refresh()} refreshing={loading && !!report}>
      <Button title={t("m.reports.back")} variant="ghost" icon="chevron-back" onPress={() => router.navigate("/reports")} style={{ alignSelf: "flex-start" }} />
      <AppText variant="title" accessibilityRole="header">{formatMonth(month, locale)}</AppText>

      {loading && !report ? <ActivityIndicator color={colors.action} style={{ padding: 24 }} /> : null}
      {!loading && !report ? <Notice tone="warning">{t("m.reports.monthNoCache")}</Notice> : null}
      {savedAt !== null ? <Notice tone="info">{`${t("m.reports.offline")} (${whenText(savedAt, t)})`}</Notice> : null}
      {failed && savedAt === null && report ? <Notice tone="warning">{t("m.reports.offline")}</Notice> : null}

      {report ? (
        <>
          <Row style={{ flexWrap: "wrap" }}>
            <Badge tone={statusTone[report.status.kind]}>
              {report.status.kind === "pending" ? t("rep.waiting", { date: formatBusinessDate(report.status.waitingFor ?? "", locale, { day: "numeric", month: "short" }) }) : t(`rep.status.${report.status.kind}` as const)}
            </Badge>
            {report.recalculated ? <Badge tone="info">{t("rep.badge.recalculated")}</Badge> : null}
            {report.lastExport?.stale ? <Badge tone="warning">{t("rep.badge.changed")}</Badge> : null}
          </Row>

          {report.notes.map((n, i) => <Notice key={i} tone={n.code === "in_progress" ? "info" : "warning"}>{noteSentence(n, t, locale)}</Notice>)}

          <Card tone="mint">
            <AppText variant="small" tone="muted">{t("rep.sales")}</AppText>
            <AppText variant="numLarge" tone="action">{formatLkr(report.totals.estimatedSales)}</AppText>
            <Badge tone="neutral">{t("common.estimated")}</Badge>
            {/* Days, not product-days: `totals.daysCalculated` counts every product on every day, so it would overstate the days. */}
            {figureDays === 0 ? <AppText tone="muted">{t("m.reports.noFigures")}</AppText> : <AppText variant="small">{t("m.reports.daysWithFigures", { n: figureDays })}</AppText>}
            {/* Say each caveat once: the notes above already carry these when the report produced them. */}
            {report.totals.daysReview > 0 && !hasNote("days_review") ? <AppText variant="small" tone="warning">{t("rep.note.days_review", { count: report.totals.daysReview })}</AppText> : null}
            {report.totals.daysPending > 0 && !hasNote("days_pending") ? <AppText variant="small" tone="muted">{t("rep.note.days_pending", { count: report.totals.daysPending })}</AppText> : null}
            <Divider />
            <AppText variant="small" tone="muted">{t("rep.closingValue")}</AppText>
            <AppText variant="num">{formatLkr(report.totals.closingValue)}</AppText>
            {/* A value of Rs. 0.00 can just mean "no purchase cost set": never let it read as a real figure. */}
            {report.totals.uncostedVariants > 0 && !hasNote("uncosted") ? <AppText variant="small" tone="warning">{t("rep.note.uncosted", { count: report.totals.uncostedVariants })}</AppText> : null}
            <AppText variant="small" tone="muted">{t("sales.estimateNote")}</AppText>
          </Card>

          {/* A report saved on the phone before this existed has no packaging block: it simply shows no section. */}
          {report.packaging && (report.packaging.known.productDays > 0 || report.packaging.unknown.productDays > 0) ? (
            <Card>
              <AppText variant="heading">{t("rep.pk.title")}</AppText>
              <AppText variant="small" tone="muted">{t("rep.pk.help")}</AppText>
              {(["known", "unknown", "standard"] as const).map((b, i) => (
                <View key={b} style={{ gap: 2, paddingTop: 8, borderTopWidth: i === 0 ? 0 : 1, borderTopColor: colors.border }}>
                  <Row style={{ justifyContent: "space-between", alignItems: "flex-start" }}>
                    <AppText style={{ fontWeight: "600", flex: 1 }}>{t(`rep.pk.${b}` as const)}</AppText>
                    <AppText variant="num">{formatLkr(report.packaging[b].amount)}</AppText>
                  </Row>
                  <AppText variant="small" tone="muted">
                    {t("rep.pk.days", { count: report.packaging[b].productDays })}
                    {Object.entries(report.packaging[b].units).map(([u, n]) => ` · ${t("rep.pk.units", { units: `${num(n)} ${u}` })}`).join("")}
                  </AppText>
                  <AppText variant="small" tone="muted">{t(`rep.pk.${b}Help` as const)}</AppText>
                </View>
              ))}
              <Divider />
              <Line label={t("rep.pk.total")} value={formatLkr(report.packaging.total)} strong />
              {report.packaging.knownProducts.length > 0 ? (
                <>
                  <AppText style={{ fontWeight: "600" }}>{t("rep.pk.breakdownTitle")}</AppText>
                  {report.packaging.knownProducts.map((k) => (
                    <View key={k.sku} style={{ gap: 2 }}>
                      <Row style={{ justifyContent: "space-between", alignItems: "flex-start" }}>
                        <AppText style={{ flex: 1 }}>{k.name}</AppText>
                        <AppText variant="num">{formatLkr(k.amount)}</AppText>
                      </Row>
                      <AppText variant="small" tone="muted">{k.packages.map((x) => `${num(x.quantity)} ${x.name}`).join(" · ")}</AppText>
                    </View>
                  ))}
                </>
              ) : <AppText variant="small" tone="muted">{t("rep.pk.noneKnown")}</AppText>}
            </Card>
          ) : null}

          <Card>
            <AppText variant="heading">{t("m.reports.daily")}</AppText>
            {peak ? (
              <>
                <BarChart points={days} summary={`${t("m.reports.daily")}. ${t("m.reports.peak", { date: formatBusinessDate(peak.key, locale, { day: "numeric", month: "short" }), amount: formatLkr(peak.amount) })}`} />
                <Row style={{ justifyContent: "space-between" }}>
                  <AppText variant="small" tone="muted">{formatBusinessDate(days[0].key, locale, { day: "numeric", month: "short" })}</AppText>
                  <AppText variant="small" tone="muted">{formatBusinessDate(days[days.length - 1].key, locale, { day: "numeric", month: "short" })}</AppText>
                </Row>
                <AppText variant="small" tone="muted">{t("m.reports.peak", { date: formatBusinessDate(peak.key, locale, { day: "numeric", month: "short" }), amount: formatLkr(peak.amount) })}</AppText>
              </>
            ) : <AppText tone="muted">{t("m.reports.noFigures")}</AppText>}
          </Card>

          <Card>
            <AppText variant="heading">{t("m.reports.best")}</AppText>
            <AppText variant="small" tone="muted">{t("m.reports.bestHelp")}</AppText>
            {best.length === 0 ? <AppText tone="muted">{t("m.reports.noFigures")}</AppText> : best.map((p, i) => (
              <View key={p.productId} style={{ gap: 2, paddingTop: 8, borderTopWidth: i === 0 ? 0 : 1, borderTopColor: colors.border }}>
                <Row style={{ justifyContent: "space-between", alignItems: "flex-start" }}>
                  <AppText style={{ fontWeight: "600", flex: 1 }}>{`${i + 1}. ${p.name}`}</AppText>
                  <AppText variant="num">{formatLkr(p.amount)}</AppText>
                </Row>
                {/* Units of different kinds are never added together: one line per unit. */}
                <AppText variant="small" tone="muted">{Object.entries(p.units).map(([u, n]) => `${num(n)} ${u}`).join(" · ") || "—"}</AppText>
              </View>
            ))}
          </Card>

          {report.stock.map((s) => (
            <Card key={s.unit}>
              <AppText variant="heading">{`${t("rep.section.stock")} (${s.unit})`}</AppText>
              <Line label={t("rep.col.opening")} value={num(s.opening)} />
              <Line label={t("rep.col.received")} value={num(s.received)} />
              <Line label={t("rep.col.returns")} value={num(s.returnedIn)} />
              <Line label={t("rep.col.damaged")} value={num(s.damagedOut)} />
              <Line label={t("rep.col.closing")} value={num(s.closing)} />
              <Line label={t("rep.col.sold")} value={num(s.unitsSold)} strong />
            </Card>
          ))}

          <Card>
            <AppText variant="heading">{t("rep.section.lowStock")}</AppText>
            {report.lowStock.length === 0 ? <AppText tone="muted">{t("rep.noLowStock")}</AppText> : report.lowStock.map((l, i) => (
              <View key={`${l.sku}-${i}`} style={{ gap: 2, paddingTop: 8, borderTopWidth: i === 0 ? 0 : 1, borderTopColor: colors.border }}>
                <AppText style={{ fontWeight: "600" }}>{[l.name, l.size].filter(Boolean).join(" ")}</AppText>
                <AppText variant="small" tone="muted">{`${num(l.quantity)} ${l.unit} (≤ ${num(l.threshold)})`}</AppText>
              </View>
            ))}
          </Card>

          <Card>
            <AppText variant="heading">{t("m.reports.share")}</AppText>
            <AppText variant="small" tone="muted">{t("m.reports.shareHelp")}</AppText>
            {shareError ? <Notice tone="danger">{t(shareError)}</Notice> : null}
            <Button title={sharing === "pdf" ? t("m.reports.preparing") : t("rep.exportPdf")} icon="document-text-outline" onPress={() => void share("pdf")} loading={sharing === "pdf"} disabled={sharing !== null} />
            <Button title={sharing === "xlsx" ? t("m.reports.preparing") : t("rep.exportExcel")} variant="secondary" icon="grid-outline" onPress={() => void share("xlsx")} loading={sharing === "xlsx"} disabled={sharing !== null} />
            <Button title={sharing === "csv" ? t("m.reports.preparing") : t("rep.exportCsv")} variant="secondary" icon="list-outline" onPress={() => void share("csv")} loading={sharing === "csv"} disabled={sharing !== null} />
          </Card>
        </>
      ) : null}
    </Screen>
  );
}

function Line({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <Row style={{ justifyContent: "space-between" }}>
      <AppText variant="small" tone="muted">{label}</AppText>
      <AppText variant="num" style={strong ? { fontWeight: "700" } : undefined}>{value}</AppText>
    </Row>
  );
}
