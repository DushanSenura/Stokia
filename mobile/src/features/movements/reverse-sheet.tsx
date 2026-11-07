import { useRef, useState } from "react";
import { Modal, ScrollView } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import type { PhoneMovement } from "@/features/movements/phone-types";
import { keyForRequest } from "@/lib/offline/idempotency";
import { useI18n } from "~/i18n";
import type { Key } from "~/i18n/types";
import { api } from "~/lib/api";
import { ApiSignedOut } from "~/lib/api-client";
import { useSession } from "~/providers/session";
import { useSync } from "~/providers/sync";
import { useTheme } from "~/theme";
import { AppText, Button, Field, Notice, Row } from "~/ui";

/**
 * Reverse a recorded movement. Nothing is deleted: a matching entry cancels the original at its original time and the affected sales
 * are recalculated. A reason is required. A retry (lost answer, double tap) reuses the same key, so it cannot reverse twice.
 */
export function ReverseSheet({ movement, onClose, onDone }: { movement: PhoneMovement; onClose: () => void; onDone: (message: Key) => void }) {
  const { t } = useI18n();
  const { colors } = useTheme();
  const { shop, signOut } = useSession();
  const { online } = useSync();
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<Key | null>(null);
  const [needReason, setNeedReason] = useState(false);
  const slot = useRef<{ fingerprint: string; key: string } | null>(null);

  const submit = async () => {
    const text = reason.trim();
    if (!text) { setNeedReason(true); return; }
    if (!online) { setProblem("m.mv.needsConnection"); return; }
    setBusy(true); setProblem(null);
    const key = keyForRequest(slot, `${movement.id}|${text}`);
    try {
      const res = await api.reverseMovement({ shopId: shop!.shopId, movementId: movement.id, reason: text, key });
      if (res.ok) { onDone(res.duplicate ? "mv.duplicate" : "mv.reversed"); return; }
      setProblem((res.fieldErrors?.reason ?? res.error ?? "auth.error.generic") as Key);
    } catch (e) {
      if (e instanceof ApiSignedOut) { await signOut(); return; }
      setProblem("m.mv.unreachable");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal visible animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <SafeAreaView style={{ flex: 1, backgroundColor: colors.bg }}>
        <ScrollView contentContainerStyle={{ padding: 16, gap: 14 }} keyboardShouldPersistTaps="handled" accessibilityViewIsModal>
          <Row style={{ justifyContent: "space-between" }}>
            <AppText variant="title" accessibilityRole="header" style={{ flex: 1 }}>{t("mv.reverse.title")}</AppText>
            <Button title={t("m.mv.close")} variant="ghost" onPress={onClose} disabled={busy} />
          </Row>
          <AppText style={{ fontWeight: "600" }}>{movement.label}</AppText>
          <AppText tone="muted">{t(`mv.type.${movement.type}` as const)} · {t("m.mv.entered", { text: movement.entered })}</AppText>
          <Notice tone="info">{t("mv.reverse.body")}</Notice>
          {problem ? <Notice tone={problem === "m.mv.unreachable" ? "warning" : "danger"}>{t(problem)}</Notice> : null}
          <Field label={t("mv.reverse.reason")} value={reason} onChangeText={(v) => { setReason(v); setNeedReason(false); setProblem(null); }} error={needReason ? t("mv.err.reason") : null} maxLength={300} />
          <Button title={busy ? t("m.mv.saving") : t("mv.reverse.submit")} variant="danger" onPress={() => void submit()} loading={busy} disabled={!online} />
        </ScrollView>
      </SafeAreaView>
    </Modal>
  );
}
