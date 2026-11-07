import { useCallback, useMemo, useRef, useState } from "react";
import { FlatList, Modal, Pressable, ScrollView, TextInput, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import type { CatalogItem } from "@/features/inventory/catalog-types";
import { PHONE_MOVEMENT_TYPES, type MovementWhen } from "@/features/movements/phone-types";
import { keyForRequest } from "@/lib/offline/idempotency";
import { useI18n } from "~/i18n";
import { fontStyle } from "~/ui/fonts";
import type { Key } from "~/i18n/types";
import { api } from "~/lib/api";
import { ApiSignedOut } from "~/lib/api-client";
import { useCachedLoad } from "~/lib/use-cached-load";
import { filterCatalog } from "~/features/products/catalog";
import { useSession } from "~/providers/session";
import { useSync } from "~/providers/sync";
import { useTheme } from "~/theme";
import { AppText, Button, Card, Field, Notice, Row, TOUCH } from "~/ui";
import { baseQuantity, blankForm, buildDraft, effectOf, problemsIn, signOf, takesCost, takesSupplier, unitOptions, type FormState } from "./form";
import { queuedDraft, summaryOf } from "./queued";

const SEARCH_LIMIT = 30;
const qty = (v: string) => Number(v).toLocaleString("en-US", { maximumFractionDigits: 3 });

/**
 * Record one stock movement. Everything the web form asks for (product, what happened, quantity in a bundle or loose, WHEN it happened,
 * a reason or reference), with the same wording and the same server-side checks. Needs a connection on purpose, and a retry is safe:
 * the same entry keeps the same key, so a lost answer or a double tap can never record it twice.
 */
export function MovementForm({ onClose, onDone }: { onClose: () => void; onDone: (message: Key) => void }) {
  const { t, locale } = useI18n();
  const { colors } = useTheme();
  const { shop, signOut } = useSession();
  const { online, enqueueMovement } = useSync();
  const shopId = shop!.shopId;
  const loader = useCallback(() => api.products(shopId), [shopId]);
  const { data: catalog, loading: catalogLoading } = useCachedLoad(`cache.products.${shopId}`, loader);

  const [f, setF] = useState<FormState>(blankForm);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [shown, setShown] = useState(false); // problems appear after the first attempt, not while the person is still typing
  const [serverErrors, setServerErrors] = useState<Record<string, string>>({});
  const [general, setGeneral] = useState<Key | null>(null);
  const keySlot = useRef<{ fingerprint: string; key: string } | null>(null);

  const set = (patch: Partial<FormState>) => { setF((s) => ({ ...s, ...patch })); setServerErrors({}); setGeneral(null); };
  const problems = useMemo(() => problemsIn(f), [f]);
  const sign = signOf(f.type);
  const base = f.item ? baseQuantity(f.item, f.unitId, f.quantity) : null;
  const effect = effectOf(f.type, f.direction, base);
  const err = (name: string): string | null => {
    const key = serverErrors[name] ?? (shown ? problems[name] : undefined);
    return key ? t(key as Key) : null;
  };

  const matches = useMemo(() => (catalog ? filterCatalog(catalog.items, { query, category: "", lowOnly: false }).slice(0, SEARCH_LIMIT) : []), [catalog, query]);
  const pick = (item: CatalogItem) => { set({ item, unitId: item.units[0]?.id ?? null }); setQuery(""); };

  const submit = async () => {
    setShown(true);
    if (Object.keys(problems).length > 0 || !f.item) return;
    setBusy(true); setGeneral(null); setServerErrors({});
    const movement = buildDraft(f);
    // One key per distinct entry: sending it again (or from the waiting list) reuses it, so it cannot be recorded twice.
    const key = keyForRequest(keySlot, JSON.stringify(movement));
    const enteredAt = new Date();

    /** Keep it on this phone to be sent later. The moment it happened is fixed NOW, not at the (later) time of sending. */
    const saveForLater = async () => {
      try {
        const r = await enqueueMovement({ key, payload: queuedDraft(movement, shop!.timezone, enteredAt), summary: summaryOf(f) });
        if (r.ok) { onDone("m.mv.queued"); return; }
      } catch { /* told below */ }
      setGeneral("m.mv.queueFailed"); // storage failed: nothing was saved, and the person is told so
    };

    try {
      if (!online) { await saveForLater(); return; }
      const res = await api.recordMovement({ shopId, movement, key });
      if (res.ok) { onDone(res.duplicate ? "mv.duplicate" : "mv.recorded"); return; }
      if (res.fieldErrors) setServerErrors(res.fieldErrors);
      else setGeneral((res.error ?? "auth.error.generic") as Key);
    } catch (e) {
      if (e instanceof ApiSignedOut) { await signOut(); return; }
      // No answer (the signal dropped, a timeout): the request may or may not have arrived. Saving it with the SAME key is safe either way.
      await saveForLater();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal visible animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <SafeAreaView style={{ flex: 1, backgroundColor: colors.bg }}>
        <ScrollView contentContainerStyle={{ padding: 16, gap: 14 }} keyboardShouldPersistTaps="handled" accessibilityViewIsModal>
          <Row style={{ justifyContent: "space-between" }}>
            <AppText variant="title" accessibilityRole="header" style={{ flex: 1 }}>{t("mv.form.title")}</AppText>
            <Button title={t("m.mv.close")} variant="ghost" onPress={onClose} disabled={busy} />
          </Row>

          {!online ? <Notice tone="info">{t("m.mv.offlineSaves")}</Notice> : null}
          {general ? <Notice tone={general === "m.mv.unreachable" ? "warning" : "danger"}>{t(general)}</Notice> : null}

          {/* ---- product ---- */}
          <AppText variant="heading">{t("mv.form.product")}</AppText>
          {f.item ? (
            <Card>
              <AppText variant="heading">{[f.item.productName, f.item.size].filter(Boolean).join(" ")}</AppText>
              <AppText variant="small" tone="muted">{f.item.sku}</AppText>
              <Button title={t("m.mv.change")} variant="secondary" onPress={() => set({ item: null, quantity: "" })} disabled={busy} />
            </Card>
          ) : (
            <View style={{ gap: 8 }}>
              <TextInput
                accessibilityLabel={t("mv.form.search")} placeholder={t("mv.form.search")} placeholderTextColor={colors.muted} value={query} onChangeText={setQuery}
                autoCorrect={false}
                style={{ minHeight: TOUCH, borderRadius: 14, borderWidth: 1.5, borderColor: colors.border, backgroundColor: colors.surface, color: colors.text, paddingHorizontal: 14, fontSize: 16, ...fontStyle(locale) }}
              />
              {catalogLoading && !catalog ? <AppText tone="muted">{t("common.loading")}</AppText> : null}
              {err("variant_id") ? <AppText tone="danger" accessibilityRole="alert">{err("variant_id")}</AppText> : null}
              <FlatList
                scrollEnabled={false} data={matches} keyExtractor={(i) => i.variantId}
                ListEmptyComponent={catalog ? <AppText tone="muted">{t("mv.form.noResults")}</AppText> : undefined}
                ItemSeparatorComponent={() => <View style={{ height: 8 }} />}
                renderItem={({ item }) => (
                  <Pressable accessibilityRole="button" onPress={() => pick(item)} style={({ pressed }) => ({ opacity: pressed ? 0.85 : 1 })}>
                    <Card style={{ minHeight: TOUCH }}>
                      <AppText style={{ fontWeight: "600" }}>{[item.productName, item.size].filter(Boolean).join(" ")}</AppText>
                      <AppText variant="small" tone="muted">{item.sku}</AppText>
                    </Card>
                  </Pressable>
                )}
              />
            </View>
          )}

          {f.item ? (
            <>
              {/* ---- what happened ---- */}
              <AppText variant="heading">{t("mv.form.type")}</AppText>
              <Chips>
                {PHONE_MOVEMENT_TYPES.map((type) => <Chip key={type} label={t(`mv.type.${type}` as const)} active={f.type === type} onPress={() => set({ type, direction: undefined })} />)}
              </Chips>
              {sign === "choose" ? (
                <>
                  <AppText variant="heading">{t("mv.form.direction")}</AppText>
                  <Chips>
                    <Chip label={t("mv.dir.in")} active={f.direction === "in"} onPress={() => set({ direction: "in" })} />
                    <Chip label={t("mv.dir.out")} active={f.direction === "out"} onPress={() => set({ direction: "out" })} />
                  </Chips>
                  {err("direction") ? <AppText tone="danger" accessibilityRole="alert">{err("direction")}</AppText> : null}
                </>
              ) : null}

              {/* ---- how much ---- */}
              <AppText variant="heading">{t("mv.form.quantity")}</AppText>
              <Chips>
                {unitOptions(f.item).map((u) => <Chip key={u.id ?? "base"} label={u.label} active={f.unitId === u.id} onPress={() => set({ unitId: u.id })} />)}
              </Chips>
              <TextInput
                accessibilityLabel={t("mv.form.quantity")} value={f.quantity} onChangeText={(v) => set({ quantity: v.replace(/[^\d.]/g, "") })}
                keyboardType={f.unitId ? "number-pad" : "decimal-pad"} inputMode={f.unitId ? "numeric" : "decimal"} placeholder="0" placeholderTextColor={colors.muted} selectTextOnFocus
                style={{ minHeight: TOUCH + 8, borderRadius: 14, borderWidth: 1.5, borderColor: err("quantity") ? colors.danger : colors.border, backgroundColor: colors.surface, color: colors.text, fontSize: 26, ...fontStyle(locale, "600"), textAlign: "center", fontVariant: ["tabular-nums"] }}
              />
              {err("quantity") ? <AppText tone="danger" accessibilityRole="alert">{err("quantity")}</AppText> : null}
              {effect !== null && base !== null ? (
                <Notice tone="info">
                  {Number(effect) < 0
                    ? t("m.mv.removesFrom", { qty: qty(base), unit: f.item.baseUnit })
                    : t("m.mv.addsTo", { qty: qty(base), unit: f.item.baseUnit })}
                </Notice>
              ) : null}

              {/* ---- when ---- */}
              <AppText variant="heading">{t("mv.form.when")}</AppText>
              <Chips>
                {(["now", "before_count"] as MovementWhen[]).map((w) => <Chip key={w} label={t(w === "now" ? "mv.when.now" : "mv.when.before")} active={f.when === w} onPress={() => set({ when: w })} />)}
              </Chips>
              <AppText variant="small" tone="muted">{t("mv.timingHelp")}</AppText>
              {err("when") ? <Notice tone="warning">{err("when")}</Notice> : null}

              {/* ---- why ---- */}
              <Field label={t("mv.form.reason")} value={f.reason} onChangeText={(reason) => set({ reason })} error={err("reason")} maxLength={300} />
              <Field label={t("mv.form.reference")} value={f.reference} onChangeText={(reference) => set({ reference })} maxLength={120} />
              {takesSupplier(f.type) ? <Field label={t("mv.form.supplier")} value={f.supplier} onChangeText={(supplier) => set({ supplier })} maxLength={120} /> : null}
              {takesCost(f.type) ? <Field label={t("mv.form.cost")} value={f.cost} onChangeText={(cost) => set({ cost: cost.replace(/[^\d.]/g, "") })} keyboardType="decimal-pad" error={err("cost")} /> : null}

              <Button title={busy ? t("m.mv.saving") : online ? t("mv.form.submit") : t("m.mv.saveOffline")} onPress={() => void submit()} loading={busy} />
            </>
          ) : null}
        </ScrollView>
      </SafeAreaView>
    </Modal>
  );
}

function Chips({ children }: { children: React.ReactNode }) {
  return <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>{children}</View>;
}

function Chip({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  const { colors } = useTheme();
  return (
    <Pressable
      accessibilityRole="button" accessibilityState={{ selected: active }} onPress={onPress}
      style={{ maxWidth: "100%", minHeight: TOUCH - 4, paddingHorizontal: 14, paddingVertical: 8, borderRadius: 14, justifyContent: "center", backgroundColor: active ? colors.action : colors.surface, borderWidth: 1, borderColor: active ? colors.action : colors.border }}
    >
      {/* Long labels (the "before this morning's count" choice) wrap inside the screen instead of running off it. */}
      <AppText variant="small" style={{ color: active ? colors.actionText : colors.text, fontWeight: "600", flexShrink: 1 }}>{label}</AppText>
    </Pressable>
  );
}
