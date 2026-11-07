import { useRouter } from "expo-router";
import { useState } from "react";
import { View } from "react-native";
import { formatBusinessDate } from "@/lib/dates/business";
import { isBlocked, type QueuedCount } from "@/lib/offline/queue-engine";
import { useI18n } from "~/i18n";
import { useSync } from "~/providers/sync";
import { AppText, Button, Notice, Row } from "~/ui";
import { confirmDialog } from "~/ui/confirm";
import { ConflictResolver } from "./conflict-resolver";

/**
 * Everything the person needs to know about counts that have not reached the server yet: offline, waiting, in conflict, or refused.
 * Nothing here ever says "confirmed" about a waiting count: only the server's answer does that, and then the entry disappears.
 */
export function SyncBanner() {
  const { t, locale } = useI18n();
  const router = useRouter();
  const { entries, online, syncing, notice, syncNow, retry, discard, editAgain } = useSync();
  const [reviewing, setReviewing] = useState<string | null>(null);
  const reviewEntry = entries.find((e) => e.id === reviewing && e.state === "conflict") ?? null;

  if (online && entries.length === 0 && !notice) return null;
  const when = (e: QueuedCount) => formatBusinessDate(e.businessDate, locale);

  const edit = async (e: QueuedCount) => {
    const date = await editAgain(e.id);
    if (date) router.navigate({ pathname: "/stock", params: { date } });
  };
  const drop = async (e: QueuedCount) => {
    if (await confirmDialog(t("sync.discard"), t("sync.discardConfirm", { date: when(e) }), t("sync.discard"), t("sync.conflict.close"))) await discard(e.id);
  };

  return (
    <View style={{ gap: 8 }} testID="sync-banner">
      {!online && <Notice tone="info">{t("sync.offline")}</Notice>}
      {notice && <Notice tone="success">{t("sync.confirmedToast", { date: formatBusinessDate(notice.date, locale) })}</Notice>}

      {entries.map((e) => {
        if (e.state === "conflict") {
          return (
            <Notice key={e.id} tone="warning">
              <AppText tone="warning" style={{ fontWeight: "600" }}>{t("sync.conflict.item", { date: when(e) })}</AppText>
              <Button title={t("sync.review")} variant="secondary" onPress={() => setReviewing(e.id)} />
            </Notice>
          );
        }
        if (e.state === "failed") {
          return (
            <Notice key={e.id} tone="danger">
              <AppText tone="danger" style={{ fontWeight: "600" }}>{t("sync.failed.item", { date: when(e) })}</AppText>
              {e.error ? <AppText tone="danger">{t(e.error)}</AppText> : null}
              <View style={{ gap: 8 }}>
                <Button title={t("sync.retry")} variant="secondary" onPress={() => void retry(e.id)} disabled={!online || syncing} />
                <Button title={t("sync.editAgain")} variant="secondary" onPress={() => void edit(e)} />
                <Button title={t("sync.discard")} variant="ghost" onPress={() => void drop(e)} />
              </View>
            </Notice>
          );
        }
        const blocked = isBlocked(entries, e);
        return (
          <Notice key={e.id} tone="info">
            <AppText tone="action" style={{ fontWeight: "600" }}>{t("sync.pending.item", { date: when(e) })}</AppText>
            <AppText variant="small">{blocked ? t("sync.blocked") : t("sync.pending.hint")}</AppText>
            <Row style={{ flexWrap: "wrap" }}>
              <Button title={syncing && !blocked ? t("sync.sending") : t("sync.sendNow")} variant="secondary" onPress={() => void syncNow()} disabled={!online || syncing || blocked} />
              {e.attempts > 0 ? <AppText variant="small" tone="muted">{t("sync.attempts", { count: e.attempts })}</AppText> : null}
            </Row>
          </Notice>
        );
      })}

      {reviewEntry ? <ConflictResolver entry={reviewEntry} onClose={() => setReviewing(null)} /> : null}
    </View>
  );
}
