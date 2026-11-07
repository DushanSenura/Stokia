import { useRouter } from "expo-router";
import { useCallback, useState } from "react";
import { ActivityIndicator, View } from "react-native";
import type { PhoneMovement } from "@/features/movements/phone-types";
import { formatShopDateTime } from "@/lib/dates/format";
import { can } from "@/server/permissions";
import { useI18n } from "~/i18n";
import type { Key } from "~/i18n/types";
import type { QueuedMovement } from "@/lib/offline/movement-queue";
import { confirmDialog } from "~/ui/confirm";
import { api } from "~/lib/api";
import { useCachedLoad } from "~/lib/use-cached-load";
import { whenText } from "~/lib/when";
import { useSession } from "~/providers/session";
import { useSync } from "~/providers/sync";
import { useTheme } from "~/theme";
import { AppText, Badge, Button, Card, Notice, Row, Screen } from "~/ui";
import { MovementForm } from "./movement-form";
import { ReverseSheet } from "./reverse-sheet";

const qty = (v: string) => Number(v).toLocaleString("en-US", { maximumFractionDigits: 3 });
const typeTone = (type: PhoneMovement["type"]) => (type === "stock_received" || type === "customer_return" ? "success" : type === "manual_adjustment" || type === "repacking" ? "info" : "warning") as "success" | "info" | "warning";

/** Stock movements: record deliveries, damage, returns and corrections, see the recent ones, and undo a mistake. */
export function MovementsScreen() {
  const { t } = useI18n();
  const { colors } = useTheme();
  const router = useRouter();
  const { shop } = useSession();
  const { online, confirmedRevision, movementEntries, discardMovement, retryMovement } = useSync();
  const shopId = shop!.shopId;
  const canWrite = can(shop!.role, "inventory.write");

  const [token, setToken] = useState(0); // bumped after recording or reversing, to reload the list
  const loader = useCallback(() => api.movements(shopId).then((r) => r.recent), [shopId]);
  const { data, savedAt, loading, failed, refresh } = useCachedLoad(`cache.movements.${shopId}`, loader, confirmedRevision + token);

  const [forming, setForming] = useState(false);
  const [reversing, setReversing] = useState<PhoneMovement | null>(null);
  const [notice, setNotice] = useState<Key | null>(null);
  const done = (message: Key) => { setForming(false); setReversing(null); setNotice(message); setToken((n) => n + 1); };

  return (
    <Screen onRefresh={() => void refresh()} refreshing={loading && !!data}>
      <Button title={t("m.mv.back")} variant="ghost" icon="chevron-back" onPress={() => router.navigate("/")} style={{ alignSelf: "flex-start" }} />
      <AppText variant="title" accessibilityRole="header">{t("m.mv.title")}</AppText>

      {!canWrite ? <Notice tone="info">{t("m.mv.viewOnly")}</Notice> : null}
      {/* "Saved on this phone" is NOT "recorded": it gets the neutral colour, not the green tick of a real success. */}
      {notice ? <Notice tone={notice === "m.mv.queued" ? "info" : "success"}>{t(notice)}</Notice> : null}
      {canWrite ? <Button title={t("m.mv.record")} icon="add-circle-outline" onPress={() => { setNotice(null); setForming(true); }} /> : null}
      {canWrite && !online ? <Notice tone="info">{t("m.mv.offlineSaves")}</Notice> : null}

      {movementEntries.length > 0 ? (
        <>
          <AppText variant="heading">{t("m.mv.waiting")}</AppText>
          <AppText variant="small" tone="muted">{t("m.mv.waitingHelp")}</AppText>
          {movementEntries.map((e) => (
            <WaitingCard key={e.id} e={e} timezone={shop!.timezone}
              onRetry={() => void retryMovement(e.id)}
              onDiscard={async () => {
                if (await confirmDialog(t("m.mv.discard"), t("m.mv.discardAsk"), t("m.mv.discard"), t("common.cancel"))) await discardMovement(e.id);
              }} />
          ))}
        </>
      ) : null}

      {loading && !data ? <ActivityIndicator color={colors.action} style={{ padding: 24 }} /> : null}
      {!loading && !data ? <Notice tone="warning">{t("m.mv.noCache")}</Notice> : null}
      {savedAt !== null ? <Notice tone="info">{t("m.mv.cached", { when: whenText(savedAt, t) })}</Notice> : null}
      {failed && savedAt === null && data ? <Notice tone="warning">{t("m.mv.refreshFailed")}</Notice> : null}

      {data ? <AppText variant="heading">{t("m.mv.recent")}</AppText> : null}
      {data && data.length === 0 ? <AppText tone="muted">{t("m.mv.none")}</AppText> : null}
      {(data ?? []).map((m) => <MovementCard key={m.id} m={m} timezone={shop!.timezone} onUndo={canWrite && online ? () => { setNotice(null); setReversing(m); } : null} />)}

      {forming ? <MovementForm onClose={() => setForming(false)} onDone={done} /> : null}
      {reversing ? <ReverseSheet movement={reversing} onClose={() => setReversing(null)} onDone={done} /> : null}
    </Screen>
  );
}

function MovementCard({ m, timezone, onUndo }: { m: PhoneMovement; timezone: string; onUndo: (() => void) | null }) {
  const { t } = useI18n();
  const { colors } = useTheme();
  const removed = Number(m.effect) < 0;
  const note = [m.reason, m.reference, m.supplier].filter(Boolean).join(" · ");
  return (
    <Card style={m.reversed ? { opacity: 0.65 } : undefined}>
      <Row style={{ flexWrap: "wrap" }}>
        <Badge tone={typeTone(m.type)}>{t(`mv.type.${m.type}` as const)}</Badge>
        {m.reversed ? <Badge tone="neutral">{t("mv.badge.reversed")}</Badge> : null}
        {m.isReversal ? <Badge tone="neutral">{t("mv.badge.reversal")}</Badge> : null}
      </Row>
      <Row style={{ justifyContent: "space-between", alignItems: "flex-start" }}>
        <AppText style={{ fontWeight: "600", flex: 1 }}>{m.label}</AppText>
        {/* The sign is part of the text, so direction never depends on colour alone. */}
        <AppText variant="num" style={{ color: removed ? colors.danger : colors.success }}>{`${removed ? "−" : "+"}${qty(String(Math.abs(Number(m.effect))))} ${m.baseUnit}`}</AppText>
      </Row>
      <AppText variant="small" tone="muted">{t("m.mv.entered", { text: m.entered })}</AppText>
      {note ? <AppText variant="small">{note}</AppText> : null}
      <AppText variant="small" tone="muted">{formatShopDateTime(m.effectiveAt, timezone)}{m.by ? ` · ${m.by}` : ""}</AppText>
      {onUndo && m.canReverse ? <Button title={t("m.mv.undo")} variant="secondary" onPress={onUndo} /> : null}
      {m.type === "repacking" && !m.reversed ? <AppText variant="small" tone="muted">{t("m.mv.undoElsewhere")}</AppText> : null}
    </Card>
  );
}

/** A movement saved on this phone that the server has not recorded. Looks different from a recorded one on purpose: it is NOT recorded yet. */
function WaitingCard({ e, timezone, onRetry, onDiscard }: { e: QueuedMovement; timezone: string; onRetry: () => void; onDiscard: () => void }) {
  const { t } = useI18n();
  const { colors } = useTheme();
  const removed = Number(e.summary.effect) < 0;
  const failed = e.state === "failed";
  const reason = failed ? Object.values(e.fieldErrors ?? {})[0] ?? e.error : undefined;
  return (
    <Card style={{ borderStyle: "dashed", borderColor: failed ? colors.danger : colors.border }}>
      <Row style={{ flexWrap: "wrap" }}>
        <Badge tone={failed ? "danger" : "warning"}>{failed ? t("m.mv.badge.failed") : t("m.mv.badge.waiting")}</Badge>
        <Badge tone="neutral">{t(`mv.type.${e.payload.type}` as const)}</Badge>
      </Row>
      <Row style={{ justifyContent: "space-between", alignItems: "flex-start" }}>
        <AppText style={{ fontWeight: "600", flex: 1 }}>{e.summary.label}</AppText>
        <AppText variant="num" style={{ color: removed ? colors.danger : colors.success }}>{`${removed ? "−" : "+"}${qty(String(Math.abs(Number(e.summary.effect))))} ${e.summary.baseUnit}`}</AppText>
      </Row>
      <AppText variant="small" tone="muted">{t("m.mv.entered", { text: e.summary.entered })}</AppText>
      <AppText variant="small" tone="muted">{t("m.mv.enteredAt", { when: formatShopDateTime(new Date(e.createdAt).toISOString(), timezone) })}</AppText>
      {reason ? <Notice tone="danger">{t(reason as Key)}</Notice> : null}
      {e.maybeSent && !failed ? <AppText variant="small" tone="muted">{t("m.mv.mayHaveSent")}</AppText> : null}
      <Row>
        {failed ? <Button title={t("m.mv.retry")} variant="secondary" onPress={onRetry} style={{ flex: 1 }} /> : null}
        {!e.maybeSent ? <Button title={t("m.mv.discard")} variant="ghost" onPress={onDiscard} style={{ flex: 1 }} /> : null}
      </Row>
    </Card>
  );
}

export function MovementsLink() {
  const { t } = useI18n();
  const router = useRouter();
  return <View><Button title={t("m.home.movements")} variant="secondary" icon="swap-vertical-outline" onPress={() => router.navigate("/more/movements")} /></View>;
}
