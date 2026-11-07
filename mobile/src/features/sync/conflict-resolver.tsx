import { useEffect, useMemo, useState } from "react";
import { Modal, ScrollView, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { formatBusinessDate } from "@/lib/dates/business";
import type { QueuedCount } from "@/lib/offline/queue-engine";
import { useI18n } from "~/i18n";
import { api } from "~/lib/api";
import { useSync } from "~/providers/sync";
import { useTheme } from "~/theme";
import { AppText, Badge, Button, Divider, Notice } from "~/ui";
import { confirmDialog } from "~/ui/confirm";

const num = (q: string) => String(Number(q)); // "70.000" -> "70"

/**
 * Shown when this phone's count met a different copy on the server. Nothing was overwritten: the person sees both sets of numbers
 * and chooses. A day that is already CONFIRMED can only change through the correction-approval flow, so there the only choices
 * are to drop this phone's copy or decide later.
 */
export function ConflictResolver({ entry, onClose }: { entry: QueuedCount; onClose: () => void }) {
  const { t, locale } = useI18n();
  const { colors } = useTheme();
  const { keepMine, discard } = useSync();
  const [busy, setBusy] = useState(false);
  const [names, setNames] = useState<Record<string, string>>({});

  const server = entry.conflict?.server ?? null;
  const confirmed = entry.conflict?.reason === "already_confirmed";
  const date = formatBusinessDate(entry.businessDate, locale);

  const rows = useMemo(() => {
    const serverQty = new Map((server?.lines ?? []).map((l) => [l.variantId, l.quantity]));
    const ids = [...new Set([...Object.keys(entry.yours), ...serverQty.keys()])];
    return ids.map((id) => {
      const mine = entry.yours[id];
      const theirs = serverQty.get(id);
      return { id, mine, theirs, same: mine !== undefined && theirs !== undefined && Number(mine) === Number(theirs), unit: entry.labels[id]?.unit ?? "" };
    });
  }, [entry, server]);

  // Products only the server counted: ask for their names.
  useEffect(() => {
    const missing = rows.filter((r) => !entry.labels[r.id]).map((r) => r.id);
    if (missing.length === 0) return;
    let live = true;
    api.variantLabels(entry.scope.split(":")[0], missing).then((m) => { if (live) setNames(m); }).catch(() => undefined);
    return () => { live = false; };
  }, [rows, entry.labels, entry.scope]);

  const nameOf = (id: string) => entry.labels[id]?.name ?? names[id] ?? "…";
  const sorted = [...rows].sort((a, b) => Number(a.same) - Number(b.same) || nameOf(a.id).localeCompare(nameOf(b.id)));

  const useMine = async () => { setBusy(true); await keepMine(entry.id); onClose(); };
  const useServer = async () => {
    if (!(await confirmDialog(t("sync.conflict.title"), t("sync.discardConfirm", { date }), t("sync.conflict.useServer"), t("sync.conflict.close")))) return;
    setBusy(true); await discard(entry.id); onClose();
  };
  const qty = (q: string | undefined, unit: string) => (q === undefined
    ? <AppText variant="small" tone="muted">{t("sync.conflict.notCounted")}</AppText>
    : <AppText variant="num">{`${num(q)} ${unit}`.trim()}</AppText>);

  return (
    <Modal visible animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <SafeAreaView style={{ flex: 1, backgroundColor: colors.bg }}>
        <ScrollView contentContainerStyle={{ padding: 16, gap: 14 }} accessibilityViewIsModal>
          <View>
            <AppText variant="title" accessibilityRole="header">{t("sync.conflict.title")}</AppText>
            <AppText tone="muted">{date}</AppText>
          </View>

          <Notice tone="warning">
            <AppText tone="warning">{confirmed ? t("sync.conflict.confirmedIntro", { date }) : server ? t("sync.conflict.draftIntro", { date }) : t("sync.conflict.draftGone", { date })}</AppText>
            {server?.by ? <AppText variant="small" tone="warning">{t("sync.conflict.by", { name: server.by })}</AppText> : null}
          </Notice>

          {rows.length > 0 && (
            <View accessibilityRole="list" style={{ gap: 0 }}>
              <View style={{ flexDirection: "row", paddingBottom: 6 }}>
                <AppText variant="small" tone="muted" style={{ flex: 1.3 }}>{t("sync.conflict.product")}</AppText>
                <AppText variant="small" tone="muted" style={{ flex: 1 }}>{t("sync.conflict.mine")}</AppText>
                <AppText variant="small" tone="muted" style={{ flex: 1 }}>{t("sync.conflict.server")}</AppText>
              </View>
              <Divider />
              {sorted.map((r) => (
                <View key={r.id} accessibilityLabel={`${nameOf(r.id)}: ${r.same ? t("sync.conflict.same") : t("sync.conflict.differs")}`} style={{ paddingVertical: 10, gap: 6 }}>
                  <View style={{ flexDirection: "row", alignItems: "center" }}>
                    <AppText style={{ flex: 1.3, fontWeight: "600" }}>{nameOf(r.id)}</AppText>
                    <View style={{ flex: 1 }}>{qty(r.mine, r.unit)}</View>
                    <View style={{ flex: 1 }}>{qty(r.theirs, r.unit)}</View>
                  </View>
                  <Badge tone={r.same ? "neutral" : "warning"}>{r.same ? t("sync.conflict.same") : t("sync.conflict.differs")}</Badge>
                  <Divider />
                </View>
              ))}
            </View>
          )}

          {confirmed ? <AppText variant="small" tone="muted">{t("sync.conflict.askCorrection")}</AppText> : null}

          <View style={{ gap: 10 }}>
            {!confirmed && <Button title={t("sync.conflict.useMine")} onPress={useMine} disabled={busy} />}
            <Button title={t("sync.conflict.useServer")} variant={confirmed ? "primary" : "secondary"} onPress={useServer} disabled={busy} />
            <Button title={t("sync.conflict.close")} variant="ghost" onPress={onClose} disabled={busy} />
          </View>
        </ScrollView>
      </SafeAreaView>
    </Modal>
  );
}
