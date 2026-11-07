import { memo, useMemo } from "react";
import { TextInput, View } from "react-native";
import { BASE_KEY, describeQuantity, evaluateItem, type EntryItem, type FieldValues } from "@/features/inventory/count-entry";
import { formatLkr } from "@/lib/formatting/money";
import { useI18n } from "~/i18n";
import { useTheme } from "~/theme";
import { AppText, Badge, Card, Notice, TOUCH } from "~/ui";

/**
 * One product to count. Large, high-contrast numeric inputs (bundles and loose items entered separately); the total, the change
 * since the last count and the estimated sales update as the person types. Blank means "not counted", never zero.
 */
function ItemCardBase({ item, values, editable, onChange }: { item: EntryItem; values: FieldValues | undefined; editable: boolean; onChange: (variantId: string, key: string, value: string) => void }) {
  const { t } = useI18n();
  const { colors } = useTheme();
  const state = useMemo(() => evaluateItem(item, values ?? {}), [item, values]);

  const fields = [
    ...item.units.map((u) => ({ key: u.id, label: u.name, integer: true })),
    { key: BASE_KEY, label: t("m.stock.loose", { unit: item.baseUnit }), integer: false },
  ];
  const title = [item.productName, item.sizeLabel].filter(Boolean).join(" · ");

  return (
    <Card style={{ borderColor: state.kind === "error" ? colors.danger : state.kind === "counted" && state.flag === "increase" ? colors.warning : colors.border }}>
      <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 8 }}>
        <View style={{ flex: 1 }}>
          <AppText variant="heading" accessibilityRole="header">{title}</AppText>
          {item.category ? <AppText variant="small" tone="muted">{item.category}</AppText> : null}
        </View>
        {state.kind === "counted" ? <Badge tone="success">✓</Badge> : null}
      </View>

      <AppText variant="small" tone="muted">
        {item.previousBase !== null
          ? t("m.stock.previous", { qty: describeQuantity(item.previousBase, item.units, item.baseUnit) })
          : t("ms.previousNone")}
      </AppText>

      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 10 }}>
        {fields.map((f) => (
          <View key={f.key} style={{ flexGrow: 1, flexBasis: "45%", gap: 4 }}>
            <AppText variant="small" tone="muted" numberOfLines={1}>{f.label}</AppText>
            <TextInput
              accessibilityLabel={`${title}, ${f.label}`}
              value={values?.[f.key] ?? ""}
              onChangeText={(v) => onChange(item.variantId, f.key, v.replace(/[^\d.]/g, ""))}
              editable={editable}
              keyboardType={f.integer ? "number-pad" : "decimal-pad"}
              inputMode={f.integer ? "numeric" : "decimal"}
              placeholder="—"
              placeholderTextColor={colors.muted}
              selectTextOnFocus
              style={{
                minHeight: TOUCH + 8, borderRadius: 14, borderWidth: 1.5, borderColor: colors.border, backgroundColor: editable ? colors.bg : colors.surfaceSoft,
                color: colors.text, fontSize: 24, fontWeight: "600", textAlign: "center", fontVariant: ["tabular-nums"],
              }}
            />
          </View>
        ))}
      </View>

      {state.kind === "error" ? <Notice tone="danger">{t("m.stock.errorField")}</Notice> : null}

      {state.kind === "counted" ? (
        <View style={{ gap: 4 }}>
          <AppText variant="num">{t("ms.total", { qty: state.baseQuantity, unit: item.baseUnit })}</AppText>
          {state.change !== null ? <AppText variant="small" tone="muted">{t("m.stock.changeLabel", { qty: state.change })}</AppText> : null}
          {state.flag === "increase" ? <Notice tone="warning">{t("ms.flag.increase")}</Notice> : null}
          {state.flag === "no_previous" ? <AppText variant="small" tone="muted">{t("ms.flag.noPrevious")}</AppText> : null}
          {state.sales?.status === "calculated" ? (
            <AppText variant="small">
              {t("m.stock.sold", { qty: `${state.sales.unitsSold} ${item.baseUnit}` })}
              {state.estimatedValue ? ` · ${formatLkr(state.estimatedValue)}` : ` · ${t("ms.noPrice")}`}
            </AppText>
          ) : null}
        </View>
      ) : null}
    </Card>
  );
}

export const ItemCard = memo(ItemCardBase);
