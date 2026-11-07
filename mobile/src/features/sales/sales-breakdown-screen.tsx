import { useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, TextInput, View } from "react-native";
import type { BreakdownHistoryEntry, BreakdownItem } from "@/features/sales/breakdown-types";
import { canPressSave, checkClear, checkSave, enteredLines, formUnits, isWholeNumber, previewBreakdown, startingQuantities } from "@/features/sales/breakdown-form";
import { breakdownErrorKey } from "@/lib/calculations/sales-breakdown";
import { addDays, formatBusinessDate, isBusinessDate } from "@/lib/dates/business";
import { formatShopDateTime, shopLocalDate } from "@/lib/dates/format";
import { formatLkr } from "@/lib/formatting/money";
import { keyForRequest } from "@/lib/offline/idempotency";
import { can } from "@/server/permissions";
import { useI18n } from "~/i18n";
import type { Key } from "~/i18n/types";
import { api } from "~/lib/api";
import { ApiSignedOut } from "~/lib/api-client";
import { kvGetJson, kvRemove, kvSetJson } from "~/lib/kv";
import { useCachedLoad } from "~/lib/use-cached-load";
import { whenText } from "~/lib/when";
import { useSession } from "~/providers/session";
import { useSync } from "~/providers/sync";
import { useTheme } from "~/theme";
import { AppText, Badge, Button, Card, Field, Notice, Row, Screen, TOUCH } from "~/ui";
import { fontStyle } from "~/ui/fonts";
import { breakdownDraftKey, newDraft, usableDraft, type BreakdownDraftState } from "./breakdown-drafts";

/**
 * The OPTIONAL "known box sales" screen for a day's inferred sales. It splits the already-inferred sale into whole packages and single
 * units and prices each with that day's prices. It never changes stock. The preview, the checks and the draft rules are the web app's
 * own shared code. What is typed is kept on the phone as a DRAFT; only Save with a connection sends it, and only the server's answer makes
 * it recorded.
 */
export function SalesBreakdownScreen() {
  const { t, locale } = useI18n();
  const router = useRouter();
  const { shop } = useSession();
  const { online, confirmedRevision, refreshData } = useSync();
  const params = useLocalSearchParams<{ date?: string }>();
  const shopId = shop!.shopId;
  // The sales date: the day the stock was sold (the day BEFORE the morning count). Yesterday when not told.
  const date = isBusinessDate(params.date) ? params.date : addDays(shopLocalDate(new Date(), shop!.timezone), -1);

  const [token, setToken] = useState(0);
  // The confirmation lives on the screen, not in the item: after a save the day reloads and the item is rebuilt (keyed by its revision).
  const [notice, setNotice] = useState<string | null>(null);
  const loader = useCallback(() => api.salesBreakdown(shopId, date), [shopId, date]);
  const { data, savedAt, loading, failed, refresh } = useCachedLoad(`cache.breakdown.${shopId}.${date}`, loader, confirmedRevision + token);

  return (
    <Screen onRefresh={() => void refresh()} refreshing={loading && !!data}>
      <Button title={t("m.mv.back")} variant="ghost" icon="chevron-back" onPress={() => router.navigate("/")} style={{ alignSelf: "flex-start" }} />
      <AppText variant="title" accessibilityRole="header">{t("m.sb.title")}</AppText>
      <AppText tone="muted">{t("sb.forDate", { date: formatBusinessDate(date, locale) })}</AppText>
      <AppText variant="small" tone="muted">{t("sb.help")}</AppText>

      {loading && !data ? <ActivityIndicator style={{ padding: 24 }} /> : null}
      {!loading && !data ? <Notice tone="warning">{t("m.sb.noCache")}</Notice> : null}
      {savedAt !== null ? <Notice tone="info">{t("m.sb.cached", { when: whenText(savedAt, t) })}</Notice> : null}
      {failed && savedAt === null && data ? <Notice tone="warning">{t("m.sb.refreshFailed")}</Notice> : null}
      {data && !data.canWrite ? <Notice tone="info">{t("sb.viewOnly")}</Notice> : null}
      {data && data.canWrite && !online ? <Notice tone="info">{t("m.sb.needsConnection")}</Notice> : null}
      {notice ? <Notice tone="success">{notice}</Notice> : null}

      {data && data.day.items.length === 0 ? <AppText tone="muted">{t("sb.none")}</AppText> : null}
      {(data?.day.items ?? []).map((item) => (
        <ItemEditor key={`${item.variantId}-${item.current?.revision ?? 0}`} item={item} date={date} canWrite={!!data?.canWrite && can(shop!.role, "inventory.write")}
          onChanged={(text) => { setNotice(text); setToken((n) => n + 1); refreshData(); }} />
      ))}
      {data && data.day.unavailable > 0 ? <AppText variant="small" tone="muted">{t("sb.unavailable", { count: data.day.unavailable })}</AppText> : null}
    </Screen>
  );
}

function ItemEditor({ item, date, canWrite, onChanged }: { item: BreakdownItem; date: string; canWrite: boolean; onChanged: (notice: string) => void }) {
  const { t, locale } = useI18n();
  const { colors } = useTheme();
  const { shop, user, signOut } = useSession();
  const { online } = useSync();
  const scope = `${shop!.shopId}:${user!.id}`;
  const draftKey = breakdownDraftKey(scope, date, item.variantId);
  const serverRevision = item.current?.revision ?? 0;
  const units = formUnits(item);

  const [qty, setQty] = useState<Record<string, string>>(() => startingQuantities(item));
  const [reason, setReason] = useState("");
  const [fromDraft, setFromDraft] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "success" | "danger" | "warning"; text: string } | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [history, setHistory] = useState<BreakdownHistoryEntry[] | null>(null);
  const keySlot = useRef<{ fingerprint: string; key: string } | null>(null);
  const loadedDraft = useRef(false);

  // A draft typed earlier (the app was closed, the signal dropped) comes back, but only if it still applies to this revision.
  useEffect(() => {
    let live = true;
    void kvGetJson<BreakdownDraftState>(draftKey).then((saved) => {
      loadedDraft.current = true;
      const d = usableDraft(saved, serverRevision);
      if (live && d) { setQty({ ...startingQuantities(item), ...d.qty }); setReason(d.reason); setFromDraft(true); }
    });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per item (the editor is keyed by its revision)
  }, []);

  /** Keep what is typed on the phone as it is typed. */
  const remember = (nextQty: Record<string, string>, nextReason: string) => {
    if (!loadedDraft.current) return;
    const typed = enteredLines(item, nextQty).length > 0 || nextReason.trim() !== "";
    const unchanged = JSON.stringify(nextQty) === JSON.stringify(startingQuantities(item)) && nextReason.trim() === "";
    if (!typed || unchanged) { void kvRemove(draftKey); setFromDraft(false); return; }
    void kvSetJson(draftKey, newDraft(serverRevision, nextQty, nextReason));
  };
  const setBox = (id: string, v: string) => {
    if (!isWholeNumber(v)) return;
    const next = { ...qty, [id]: v };
    setQty(next); setMessage(null); setFieldErrors({}); remember(next, reason);
  };
  const setWhy = (v: string) => { setReason(v); setMessage(null); remember(qty, v); };
  const discardDraft = () => { void kvRemove(draftKey); setQty(startingQuantities(item)); setReason(""); setFromDraft(false); setMessage(null); };

  const { entered: anyEntered, result } = previewBreakdown(item, qty);
  const editing = item.current !== null;
  const base = item.base.name;
  const status = item.packagingStatus;
  const money = (v: string | null) => (v === null ? "-" : formatLkr(v));

  const save = async () => {
    setMessage(null); setFieldErrors({});
    const check = checkSave(item, date, qty, reason);
    if (!check.ok) { setMessage({ tone: "danger", text: t(check.error) }); return; }
    if (!online) { setMessage({ tone: "warning", text: t("m.sb.needsConnection") }); return; }
    setBusy(true);
    const key = keyForRequest(keySlot, JSON.stringify(check.draft));
    try {
      const r = await api.saveSalesBreakdown({ shopId: shop!.shopId, draft: check.draft, key });
      if (r.ok) { await kvRemove(draftKey); onChanged(t(r.duplicate ? "sb.duplicate" : "sb.saved")); return; }
      setFieldErrors(r.fieldErrors ?? {});
      setMessage({ tone: "danger", text: t((r.error ?? "auth.error.generic") as Key) });
    } catch (e) {
      if (e instanceof ApiSignedOut) { await signOut(); return; }
      setMessage({ tone: "warning", text: t("m.sb.unreachable") }); // the draft stays; the same key is reused next time
    } finally {
      setBusy(false);
    }
  };

  const clear = async () => {
    setMessage(null);
    const check = checkClear(reason);
    if (!check.ok) { setMessage({ tone: "danger", text: t(check.error) }); return; }
    if (!online) { setMessage({ tone: "warning", text: t("m.sb.needsConnection") }); return; }
    setBusy(true);
    const input = { shopId: shop!.shopId, variantId: item.variantId, date, reason: reason.trim() };
    try {
      const r = await api.clearSalesBreakdown({ ...input, key: keyForRequest(keySlot, `clear|${JSON.stringify(input)}`) });
      if (r.ok) { await kvRemove(draftKey); onChanged(t("sb.cleared")); return; }
      setMessage({ tone: "danger", text: t((r.error ?? "auth.error.generic") as Key) });
    } catch (e) {
      if (e instanceof ApiSignedOut) { await signOut(); return; }
      setMessage({ tone: "warning", text: t("m.sb.unreachable") });
    } finally {
      setBusy(false);
    }
  };

  const showHistory = async () => {
    if (history) { setHistory(null); return; }
    try { setHistory((await api.salesBreakdownHistory(shop!.shopId, item.variantId, date)).history); }
    catch (e) { if (e instanceof ApiSignedOut) { await signOut(); return; } setMessage({ tone: "warning", text: t("m.sb.historyFailed") }); }
  };

  const label = [item.name, item.size].filter(Boolean).join(" ");
  return (
    <Card>
      <Row style={{ justifyContent: "space-between", alignItems: "flex-start" }}>
        <View style={{ flex: 1 }}>
          <AppText variant="heading">{label}</AppText>
          <AppText variant="small" tone="muted">{item.sku} · {t("sb.inferred")}: {item.inferred} {base}</AppText>
        </View>
      </Row>
      <View style={{ alignItems: "flex-start" }}>
        {status === "known" ? <Badge tone="success">{t("sb.status.known")}</Badge>
          : status === "stale" ? <Badge tone="warning">{t("sb.status.stale")}</Badge>
          : <Badge tone="neutral">{t("sb.status.unknown", { unit: base })}</Badge>}
      </View>
      {status === "stale" ? <Notice tone="warning">{t("sb.staleNote", { unit: base })}</Notice> : null}
      {fromDraft ? <Notice tone="info">{t("m.sb.draftKept")}</Notice> : null}

      {units.map((u) => {
        const err = fieldErrors[u.id];
        const q = (qty[u.id] ?? "").trim();
        const eq = q && isWholeNumber(q) ? Number(q) * Number(u.multiplier) : null;
        return (
          <View key={u.id} style={{ gap: 4 }}>
            <AppText style={{ fontWeight: "600" }}>{t("sb.soldIn", { unit: u.name })}</AppText>
            <TextInput
              accessibilityLabel={t("sb.soldIn", { unit: u.name })} value={qty[u.id] ?? ""} onChangeText={(v) => setBox(u.id, v)} editable={canWrite && !busy}
              keyboardType="number-pad" inputMode="numeric" placeholder="0" placeholderTextColor={colors.muted} selectTextOnFocus
              style={{ minHeight: TOUCH + 4, borderRadius: 14, borderWidth: 1.5, borderColor: err ? colors.danger : colors.border, backgroundColor: colors.surface, color: colors.text, fontSize: 22, textAlign: "center", fontVariant: ["tabular-nums"], ...fontStyle(locale, "600") }}
            />
            <AppText variant="small" tone="muted">
              {u.price === null ? t("sb.noPrice", { unit: u.name }) : `${formatLkr(u.price)} · ${t("sb.soldInHelp", { unit: u.name })}`}
              {eq !== null && eq > 0 ? ` · ${t("sb.equivalent", { unit: base })}: ${eq}` : ""}
            </AppText>
            {err ? <AppText tone="danger" variant="small" accessibilityRole="alert">{t(err as Key)}</AppText> : null}
          </View>
        );
      })}

      {/* The preview: the same rule as the database, so what is shown is what will be stored. */}
      <Card tone="mint" style={{ gap: 4 }}>
        {anyEntered && result.ok ? (
          <>
            {result.lines.map((l) => <AppText key={l.unitId ?? "base"} variant="small">{t("sb.line", { qty: l.quantity, name: l.name, price: formatLkr(l.unitPrice), amount: formatLkr(l.amount) })}</AppText>)}
            <AppText variant="small">{t("sb.individual", { unit: base })}: {result.remainder}</AppText>
            <AppText variant="num">{t("sb.revenueKnown")}: {money(result.amount)}</AppText>
            {item.plainEstimate ? <AppText variant="small" tone="muted">{t("sb.compare", { amount: formatLkr(item.plainEstimate) })}</AppText> : null}
          </>
        ) : anyEntered && !result.ok ? (
          <AppText tone="danger" accessibilityRole="alert">{t(breakdownErrorKey(result.error))}</AppText>
        ) : (
          <>
            <AppText variant="num">{t("sb.revenueUnknown")}: {money(item.plainEstimate)}</AppText>
            <AppText variant="small" tone="muted">{t("sb.status.unknown", { unit: base })}</AppText>
          </>
        )}
      </Card>

      {canWrite ? (
        <>
          {editing ? <Field label={t("sb.reason")} value={reason} onChangeText={setWhy} maxLength={300} editable={!busy} /> : null}
          {message ? <Notice tone={message.tone}>{message.text}</Notice> : null}
          <Button title={busy ? t("sb.saving") : editing ? t("sb.update") : t("sb.save")} onPress={() => void save()} loading={busy} disabled={!canPressSave(item, qty)} />
          {editing ? <Button title={t("sb.clear")} variant="secondary" onPress={() => void clear()} disabled={busy} /> : null}
          {fromDraft ? <Button title={t("m.sb.discardDraft")} variant="ghost" onPress={discardDraft} disabled={busy} /> : null}
        </>
      ) : message ? <Notice tone={message.tone}>{message.text}</Notice> : null}

      {editing ? (
        <>
          <Button title={t("sb.history")} variant="ghost" onPress={() => void showHistory()} style={{ alignSelf: "flex-start" }} />
          {history ? (
            <View style={{ gap: 8 }}>
              {history.length === 0 ? <AppText tone="muted">{t("sb.historyNone")}</AppText> : null}
              {history.map((h) => (
                <View key={`${h.revision}-${h.action}`} style={{ borderWidth: 1, borderColor: colors.border, borderRadius: 14, padding: 10, gap: 2 }}>
                  <AppText style={{ fontWeight: "600" }}>{t(`sb.action.${h.action}` as const)}{h.amount ? ` · ${formatLkr(h.amount)}` : ""}</AppText>
                  <AppText variant="small" tone="muted">{formatShopDateTime(h.at, shop!.timezone)} · {h.by ? t("sb.historyBy", { name: h.by }) : t("sb.historySystem")}</AppText>
                  {h.lines.length > 0 ? <AppText variant="small">{h.lines.map((l) => `${l.quantity} ${l.name}`).join(" · ")}</AppText> : null}
                  {h.reason ? <AppText variant="small" tone="muted">{h.reason}</AppText> : null}
                </View>
              ))}
            </View>
          ) : null}
        </>
      ) : null}
    </Card>
  );
}
