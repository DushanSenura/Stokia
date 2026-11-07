import { Ionicons } from "@expo/vector-icons";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, FlatList, Pressable, ScrollView, TextInput, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { buildPayloadItems, evaluateItem, summarize, type EntryItem } from "@/features/inventory/count-entry";
import type { SalesSummary } from "@/features/inventory/count-types";
import { formatBusinessDate } from "@/lib/dates/business";
import { formatLkr } from "@/lib/formatting/money";
import { confirmOrQueue } from "@/lib/offline/confirm-flow";
import { keyForRequest } from "@/lib/offline/idempotency";
import type { MessageKey } from "@/i18n";
import { useI18n } from "~/i18n";
import { fontStyle } from "~/ui/fonts";
import type { MobileKey } from "~/i18n/mobile-strings";
import { api } from "~/lib/api";
import { deviceLabel } from "~/lib/device";
import { useSession } from "~/providers/session";
import { useSync } from "~/providers/sync";
import { useTheme } from "~/theme";
import { AppText, Button, Card, Notice, Row, TOUCH } from "~/ui";
import { SyncBanner } from "~/features/sync/sync-banner";
import { ItemCard } from "./item-card";
import { useMorningStock } from "./use-morning-stock";

type Step = "entry" | "review" | "done";
type Filter = "all" | "notCounted" | "attention";

/** The highest-priority screen: count the shelves each morning, fast, with big numbers, with or without a connection. */
export function StockScreen() {
  const { t, locale } = useI18n();
  const { colors } = useTheme();
  const router = useRouter();
  const { shop } = useSession();
  const sync = useSync();
  const params = useLocalSearchParams<{ date?: string }>();
  const ms = useMorningStock(typeof params.date === "string" ? params.date : undefined);
  const { data, values } = ms;

  const [step, setStep] = useState<Step>("entry");
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [ack, setAck] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [problem, setProblem] = useState<MessageKey | MobileKey | null>(null);
  const [queuedDone, setQueuedDone] = useState(false);
  const [done, setDone] = useState<{ sales?: SalesSummary; alreadyConfirmed: boolean } | null>(null);
  const confirmKey = useRef<{ fingerprint: string; key: string } | null>(null);

  // The headline total follows later changes to the day's figure (a sales breakdown saved on its own screen changes what the day is worth).
  const revisionAtDone = useRef(sync.confirmedRevision);
  useEffect(() => {
    if (!done || sync.confirmedRevision === revisionAtDone.current) return;
    revisionAtDone.current = sync.confirmedRevision;
    let live = true;
    void api.home(shop!.shopId).then((h) => { if (live && h.sales) setDone((d) => (d ? { ...d, sales: h.sales! } : d)); }).catch(() => undefined);
    return () => { live = false; };
  }, [done, sync.confirmedRevision, shop]);

  const items = useMemo(() => data?.items ?? [], [data]);
  const canWrite = !!data && (data.canWrite ?? true);
  // Summaries and filters look at every product; let typing stay responsive and catch up a moment later.
  const deferred = useDeferredValue(values);
  const summary = useMemo(() => summarize(items, deferred), [items, deferred]);
  const categories = useMemo(() => [...new Set(items.map((i) => i.category).filter((c): c is string => !!c))].sort(), [items]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return items.filter((it) => {
      if (category && it.category !== category) return false;
      if (q && !`${it.productName} ${it.productCode} ${it.sku} ${it.sizeLabel}`.toLowerCase().includes(q)) return false;
      if (filter === "all") return true;
      const st = evaluateItem(it, deferred[it.variantId] ?? {});
      return filter === "notCounted" ? st.kind === "not_counted" : st.kind === "error" || (st.kind === "counted" && st.flag === "increase");
    });
  }, [items, query, category, filter, deferred]);

  const missing = useMemo(() => items.filter((it) => evaluateItem(it, deferred[it.variantId] ?? {}).kind === "not_counted"), [items, deferred]);

  const confirm = useCallback(async () => {
    if (!data || !shop) return;
    setConfirming(true); setProblem(null);
    const current = ms.valuesRef.current;
    const payload = { businessDate: data.businessDate, revision: data.session?.revision ?? null, items: buildPayloadItems(items, current) };
    // One key per distinct request: a retry after a lost response (or a double tap) reuses it and can never apply twice.
    const key = keyForRequest(confirmKey, JSON.stringify([payload, ack]));

    const queueInput = () => {
      const labels: Record<string, { name: string; unit: string }> = {};
      const yours: Record<string, string> = {};
      for (const line of payload.items) {
        const item = items.find((i) => i.variantId === line.variantId);
        if (!item) continue;
        labels[item.variantId] = { name: [item.productName, item.sizeLabel].filter(Boolean).join(" "), unit: item.baseUnit };
        const st = evaluateItem(item, current[item.variantId] ?? {});
        if (st.kind === "counted") yours[item.variantId] = st.baseQuantity;
      }
      return { scope: ms.scope, businessDate: data.businessDate, payload, ack, key, labels, yours };
    };

    // The decision (confirm / keep on the phone / keep as a conflict) is the SAME shared code the web app runs.
    const outcome = await confirmOrQueue({
      online: sync.online, canQueue: true,
      submit: () => api.submitCount({ shopId: shop.shopId, count: payload, ackMissing: ack, key, device: deviceLabel() }),
      queueInput, enqueue: sync.enqueue, recordConflict: sync.recordConflict,
    });
    setConfirming(false);

    switch (outcome.kind) {
      case "queued": ms.release(); setQueuedDone(true); setStep("done"); break;
      case "queue_failed": setProblem(outcome.reason === "exists" ? "sync.exists" : "sync.cannotQueue"); break;
      case "confirmed": ms.release(); setDone({ sales: outcome.result.sales, alreadyConfirmed: !!outcome.result.alreadyConfirmed }); setStep("done"); break;
      case "conflict": ms.release(); setProblem(outcome.result.error); setStep("entry"); break;
      case "rejected": setProblem(outcome.result.error); break;
    }
  }, [data, shop, items, ack, ms, sync]);

  /* ---------------- states before there is anything to count ---------------- */
  if (ms.loading && !data) return <Centered><ActivityIndicator color={colors.action} size="large" /></Centered>;
  if (!data) {
    return (
      <Centered>
        <Notice tone={ms.error === "forbidden" ? "danger" : "warning"}>{ms.error === "forbidden" ? t("error.forbidden") : t("m.stock.noCache")}</Notice>
        <Button title={t("common.retry")} onPress={() => void ms.reload()} />
      </Centered>
    );
  }

  const dateLabel = formatBusinessDate(data.businessDate, locale);
  const salesLabel = formatBusinessDate(data.salesDate, locale);

  /* ---------------- this morning is already confirmed ---------------- */
  if (data.confirmedSessionId) {
    return (
      <Centered>
        <Ionicons name="checkmark-circle" size={72} color={colors.action} accessible={false} style={{ alignSelf: "center" }} />
        <AppText variant="title" accessibilityRole="header" style={{ textAlign: "center" }}>{t("ms.status.confirmed")}</AppText>
        <Notice tone="success">{t("ms.confirmedBanner", { date: dateLabel })}</Notice>
      </Centered>
    );
  }

  /* ---------------- saved on this phone, waiting for the server ---------------- */
  if (step === "done" && queuedDone) {
    // Once the server has answered with a conflict or a refusal, the banner below says so: do not keep promising "will be sent".
    const waiting = sync.entries.find((e) => e.businessDate === data.businessDate);
    const stillPending = !waiting || waiting.state === "pending";
    return (
      <Centered>
        <Ionicons name="time" size={72} color={colors.info} accessible={false} style={{ alignSelf: "center" }} />
        <AppText variant="title" accessibilityRole="header" style={{ textAlign: "center" }}>{t("sync.queuedTitle")}</AppText>
        {stillPending ? (
          <>
            <AppText tone="muted" style={{ textAlign: "center" }}>{t("sync.queuedBody", { date: dateLabel })}</AppText>
            <Notice tone="info">{t("sync.queuedHint")}</Notice>
          </>
        ) : null}
        <SyncBanner />
        <Button title={t("m.tab.home")} onPress={() => router.navigate("/")} />
      </Centered>
    );
  }

  /* ---------------- confirmed ---------------- */
  if (step === "done" && done) {
    const s = done.sales;
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: colors.bg }}>
        <ScrollView contentContainerStyle={{ padding: 24, gap: 14, alignItems: "center" }}>
          <Ionicons name="checkmark-circle" size={80} color={colors.action} accessible={false} />
          <AppText variant="title" accessibilityRole="header">{t("ms.successTitle")}</AppText>
          <AppText tone="muted" style={{ textAlign: "center" }}>{t("ms.successBody", { date: dateLabel })}</AppText>
          {data.previousDate === null ? <AppText tone="muted" style={{ textAlign: "center" }}>{t("ms.successFirst")}</AppText> : null}
          {s && s.calculated > 0 ? (
            <Card style={{ alignSelf: "stretch", alignItems: "center" }} tone="mint">
              <AppText variant="heading">{t("ms.successSales")}</AppText>
              <AppText variant="small" tone="muted">{t("ms.successTotal", { date: salesLabel })}</AppText>
              <AppText variant="numLarge" tone="action">{formatLkr(s.estimatedTotal)}</AppText>
              {Object.keys(s.unitsByBaseUnit).length > 0 ? <AppText variant="small">{Object.entries(s.unitsByBaseUnit).map(([u, n]) => `${n} ${u}`).join(" · ")}</AppText> : null}
              {s.needsReview > 0 ? <AppText variant="small" tone="warning">{t("ms.successReview", { count: s.needsReview })}</AppText> : null}
              {s.pending > 0 ? <AppText variant="small" tone="muted">{t("ms.successPending", { count: s.pending })}</AppText> : null}
            </Card>
          ) : null}
          {data.previousDate !== null ? <AppText variant="small" tone="muted" style={{ textAlign: "center" }}>{t("sales.estimateNote")}</AppText> : null}
          {/* Optional, on its own screen: the morning count itself stays uncluttered. Only after the server confirmed the count (never for a queued one). */}
          {data.previousDate !== null && s && s.calculated > 0
            ? <Button title={t("m.stock.addBreakdown")} variant="secondary" icon="cube-outline" onPress={() => router.navigate(`/more/sales-breakdown?date=${data.salesDate}`)} style={{ alignSelf: "stretch" }} />
            : null}
          <Button title={t("m.tab.home")} onPress={() => router.navigate("/")} style={{ alignSelf: "stretch" }} />
        </ScrollView>
      </SafeAreaView>
    );
  }

  /* ---------------- review ---------------- */
  if (step === "review") {
    const canConfirm = summary.errors === 0 && summary.counted > 0 && (missing.length === 0 || ack);
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: colors.bg }}>
        <ScrollView contentContainerStyle={{ padding: 16, gap: 12 }} keyboardShouldPersistTaps="handled">
          <AppText variant="title" accessibilityRole="header">{t("ms.reviewTitle")}</AppText>
          <AppText tone="muted">{t("ms.countDate", { date: dateLabel })}</AppText>
          <AppText tone="muted">{t("ms.calculatesFor", { date: salesLabel })}</AppText>

          <Row style={{ flexWrap: "wrap" }}>
            <Stat label={t("ms.reviewCounted")} value={summary.counted} />
            <Stat label={t("ms.reviewNotCounted")} value={summary.notCounted} />
            <Stat label={t("ms.reviewNeedsReview")} value={summary.needsReview} warn={summary.needsReview > 0} />
          </Row>

          {data.previousDate !== null ? (
            <Card tone="mint">
              <AppText variant="small" tone="muted">{t("ms.reviewEstSales")}</AppText>
              <AppText variant="numLarge" tone="action">{formatLkr(summary.estimatedTotal)}</AppText>
              {Object.keys(summary.unitsByBaseUnit).length > 0 ? (
                <AppText variant="small">{t("ms.reviewUnitsSold")}: {Object.entries(summary.unitsByBaseUnit).map(([u, n]) => `${n} ${u}`).join(" · ")}</AppText>
              ) : null}
              <AppText variant="small" tone="muted">{t("sales.estimateNote")}</AppText>
            </Card>
          ) : <Notice tone="info">{t("ms.firstCount")}</Notice>}

          {data.gapDays > 1 && data.previousDate ? <Notice tone="warning">{t("ms.gap", { date: formatBusinessDate(data.previousDate, locale), days: data.gapDays })}</Notice> : null}
          {summary.errors > 0 ? <Notice tone="danger">{t("ms.fixErrors")}</Notice> : null}

          {missing.length > 0 ? (
            <Card>
              <AppText variant="heading">{t("ms.reviewMissingList")} ({missing.length})</AppText>
              <AppText variant="small" tone="muted" numberOfLines={4}>{missing.slice(0, 8).map((m) => m.productName).join(", ")}{missing.length > 8 ? "…" : ""}</AppText>
              <Pressable
                accessibilityRole="checkbox" accessibilityState={{ checked: ack }} onPress={() => setAck((a) => !a)}
                style={{ flexDirection: "row", gap: 12, alignItems: "center", minHeight: TOUCH, paddingVertical: 6 }}
              >
                <Ionicons name={ack ? "checkbox" : "square-outline"} size={28} color={colors.action} />
                <AppText style={{ flex: 1 }}>{t("ms.ackMissing", { count: missing.length })}</AppText>
              </Pressable>
            </Card>
          ) : null}

          {problem ? <Notice tone="danger">{t(problem)}</Notice> : null}
          <SyncBanner />
          <Button title={confirming ? t("ms.confirming") : t("ms.confirm")} onPress={() => void confirm()} disabled={!canConfirm || !canWrite} loading={confirming} />
          <Button title={t("ms.back")} variant="secondary" onPress={() => { setStep("entry"); setProblem(null); }} disabled={confirming} />
        </ScrollView>
      </SafeAreaView>
    );
  }

  /* ---------------- entry ---------------- */
  const pct = summary.total ? Math.round((summary.counted / summary.total) * 100) : 0;
  const header = (
    <View style={{ gap: 10, paddingBottom: 6 }}>
      <View>
        <AppText variant="title" accessibilityRole="header">{t("ms.title")}</AppText>
        <AppText variant="num">{t("ms.countDate", { date: dateLabel })}</AppText>
        <AppText tone="muted">{t("ms.calculatesFor", { date: salesLabel })}</AppText>
      </View>
      <SyncBanner />
      {source(ms.source, t)}
      {ms.restored ? <Notice tone="info">{t("m.stock.deviceDraft")}</Notice> : null}
      {!canWrite ? <Notice tone="info">{t("ms.readOnly")}</Notice> : null}
      {data.truncated ? <Notice tone="warning">{t("ms.limit", { count: items.length })}</Notice> : null}
      {problem ? <Notice tone="danger">{t(problem)}</Notice> : null}

      <View accessibilityRole="progressbar" accessibilityLabel={t("ms.progress", { counted: summary.counted, total: summary.total })} accessibilityValue={{ min: 0, max: summary.total, now: summary.counted }}>
        <View style={{ height: 10, borderRadius: 5, backgroundColor: colors.surfaceSoft, overflow: "hidden" }}>
          <View style={{ width: `${pct}%`, height: 10, backgroundColor: colors.primary }} />
        </View>
        <AppText variant="small" tone="muted" style={{ marginTop: 4 }}>{t("ms.progress", { counted: summary.counted, total: summary.total })}</AppText>
      </View>

      <TextInput
        accessibilityLabel={t("ms.search")} placeholder={t("ms.search")} placeholderTextColor={colors.muted} value={query} onChangeText={setQuery}
        autoCorrect={false} clearButtonMode="while-editing" returnKeyType="search"
        style={{ minHeight: TOUCH, borderRadius: 14, borderWidth: 1.5, borderColor: colors.border, backgroundColor: colors.surface, color: colors.text, paddingHorizontal: 14, fontSize: 16, ...fontStyle(locale) }}
      />
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>
        {(["all", "notCounted", "attention"] as Filter[]).map((f) => (
          <Chip key={f} label={t(`ms.filter.${f}` as const)} active={filter === f} onPress={() => setFilter(f)} />
        ))}
        {categories.length > 0 ? <Chip label={t("ms.allCategories")} active={category === ""} onPress={() => setCategory("")} /> : null}
        {categories.map((c) => <Chip key={c} label={c} active={category === c} onPress={() => setCategory(category === c ? "" : c)} />)}
      </ScrollView>
    </View>
  );

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.bg }} edges={["top", "left", "right"]}>
      <FlatList<EntryItem>
        data={visible}
        keyExtractor={(i) => i.variantId}
        renderItem={({ item }) => <ItemCard item={item} values={values[item.variantId]} editable={canWrite} onChange={ms.setValue} />}
        ListHeaderComponent={header}
        ListEmptyComponent={<AppText tone="muted" style={{ textAlign: "center", padding: 24 }}>{items.length === 0 ? t("ms.noItems") : t("m.stock.noMatches")}</AppText>}
        contentContainerStyle={{ padding: 16, gap: 12, paddingBottom: 110 }}
        ItemSeparatorComponent={undefined}
        keyboardShouldPersistTaps="handled"
        initialNumToRender={8}
        windowSize={7}
        removeClippedSubviews
      />
      <View style={{ position: "absolute", left: 0, right: 0, bottom: 0, padding: 12, backgroundColor: colors.surface, borderTopWidth: 1, borderTopColor: colors.border }}>
        <Button
          title={t("m.stock.openReview", { counted: summary.counted, total: summary.total })}
          onPress={() => { setAck(false); setProblem(null); setStep("review"); }}
          disabled={summary.counted === 0 || summary.errors > 0 || !canWrite}
        />
      </View>
    </SafeAreaView>
  );
}

function source(from: "server" | "phone", t: ReturnType<typeof useI18n>["t"]) {
  return from === "phone" ? <Notice tone="info">{t("m.stock.offlineCached")}</Notice> : null;
}

function Centered({ children }: { children: React.ReactNode }) {
  const { colors } = useTheme();
  return <SafeAreaView style={{ flex: 1, backgroundColor: colors.bg }}><View style={{ flex: 1, padding: 24, gap: 14, alignItems: "stretch", justifyContent: "center" }}>{children}</View></SafeAreaView>;
}

function Stat({ label, value, warn }: { label: string; value: number; warn?: boolean }) {
  const { colors } = useTheme();
  return (
    <View style={{ flexGrow: 1, flexBasis: "30%", borderRadius: 16, padding: 12, backgroundColor: warn ? colors.warningSoft : colors.surfaceSoft }}>
      <AppText variant="small" tone={warn ? "warning" : "muted"} numberOfLines={2}>{label}</AppText>
      <AppText variant="numLarge" tone={warn ? "warning" : undefined}>{value}</AppText>
    </View>
  );
}

function Chip({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  const { colors } = useTheme();
  return (
    <Pressable
      accessibilityRole="button" accessibilityState={{ selected: active }} onPress={onPress}
      style={{ minHeight: 40, paddingHorizontal: 14, borderRadius: 999, justifyContent: "center", backgroundColor: active ? colors.action : colors.surface, borderWidth: 1, borderColor: active ? colors.action : colors.border }}
    >
      <AppText variant="small" style={{ color: active ? colors.actionText : colors.text, fontWeight: "600" }}>{label}</AppText>
    </Pressable>
  );
}
