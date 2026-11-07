import { useCallback, useMemo, useState } from "react";
import { ActivityIndicator, FlatList, Pressable, RefreshControl, ScrollView, TextInput, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import type { CatalogItem } from "@/features/inventory/catalog-types";
import { formatBusinessDate } from "@/lib/dates/business";
import { formatLkr } from "@/lib/formatting/money";
import { useI18n } from "~/i18n";
import { api } from "~/lib/api";
import { useCachedLoad } from "~/lib/use-cached-load";
import { whenText } from "~/lib/when";
import { useSession } from "~/providers/session";
import { useSync } from "~/providers/sync";
import { useTheme } from "~/theme";
import { AppText, Badge, Card, Notice, TOUCH } from "~/ui";
import { categoriesOf, filterCatalog, groupByProduct, type ProductGroup } from "./catalog";

const qty = (v: string) => Number(v).toLocaleString("en-US", { maximumFractionDigits: 3 });

/** Browse the shop's products: price, last counted quantity, low-stock flag and packaging. View-only (any role). */
export function ProductsScreen() {
  const { t, locale } = useI18n();
  const { colors } = useTheme();
  const { shop } = useSession();
  const { confirmedRevision } = useSync();
  const shopId = shop!.shopId;
  const loader = useCallback(() => api.products(shopId), [shopId]);
  const { data, savedAt, loading, failed, refresh } = useCachedLoad(`cache.products.${shopId}`, loader, confirmedRevision);

  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("");
  const [lowOnly, setLowOnly] = useState(false);

  const items = useMemo(() => data?.items ?? [], [data]);
  const categories = useMemo(() => categoriesOf(items), [items]);
  const groups = useMemo(() => groupByProduct(filterCatalog(items, { query, category, lowOnly })), [items, query, category, lowOnly]);
  const lowTotal = useMemo(() => items.filter((i) => i.low).length, [items]);

  const header = (
    <View style={{ gap: 10, paddingBottom: 6 }}>
      <View>
        <AppText variant="title" accessibilityRole="header">{t("m.products.title")}</AppText>
        {data ? <AppText tone="muted">{t("m.products.count", { n: items.length })}</AppText> : null}
      </View>
      <Notice tone="neutral">{t("m.products.viewOnly")}</Notice>
      {savedAt !== null ? <Notice tone="info">{t("m.products.cached", { when: whenText(savedAt, t) })}</Notice> : null}
      {failed && savedAt === null && data ? <Notice tone="warning">{t("m.products.refreshFailed")}</Notice> : null}
      {data?.asOf ? <AppText variant="small" tone="muted">{t("m.products.asOf", { date: formatBusinessDate(data.asOf, locale) })}</AppText> : data ? <AppText variant="small" tone="muted">{t("m.products.noCount")}</AppText> : null}
      {data?.truncated ? <Notice tone="warning">{t("ms.limit", { count: items.length })}</Notice> : null}
      <TextInput
        accessibilityLabel={t("m.products.search")} placeholder={t("m.products.search")} placeholderTextColor={colors.muted} value={query} onChangeText={setQuery}
        autoCorrect={false} clearButtonMode="while-editing"
        style={{ minHeight: TOUCH, borderRadius: 14, borderWidth: 1.5, borderColor: colors.border, backgroundColor: colors.surface, color: colors.text, paddingHorizontal: 14, fontSize: 16 }}
      />
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>
        <Chip label={`${t("m.products.lowOnly")} (${lowTotal})`} active={lowOnly} onPress={() => setLowOnly((v) => !v)} />
        {categories.map((c) => <Chip key={c} label={c} active={category === c} onPress={() => setCategory(category === c ? "" : c)} />)}
      </ScrollView>
    </View>
  );

  if (loading && !data) {
    return <Frame><ActivityIndicator color={colors.action} size="large" style={{ marginTop: 48 }} /></Frame>;
  }
  if (!data) return <Frame><View style={{ padding: 16 }}><Notice tone="warning">{t("m.products.noCache")}</Notice></View></Frame>;

  return (
    <Frame>
      <FlatList<ProductGroup>
        data={groups}
        keyExtractor={(g) => g.key}
        renderItem={({ item }) => <ProductCard group={item} />}
        ListHeaderComponent={header}
        ListEmptyComponent={<AppText tone="muted" style={{ textAlign: "center", padding: 24 }}>{items.length === 0 ? t("m.products.none") : t("m.products.empty")}</AppText>}
        contentContainerStyle={{ padding: 16, gap: 12 }}
        keyboardShouldPersistTaps="handled"
        initialNumToRender={8}
        windowSize={7}
        refreshControl={<RefreshControl refreshing={loading} onRefresh={() => void refresh()} tintColor={colors.action} />}
      />
    </Frame>
  );
}

function ProductCard({ group }: { group: ProductGroup }) {
  const { t } = useI18n();
  return (
    <Card>
      <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 8 }}>
        <View style={{ flex: 1 }}>
          <AppText variant="heading" accessibilityRole="header">{group.name}</AppText>
          <AppText variant="small" tone="muted">{[group.code, group.category].filter(Boolean).join(" · ")}</AppText>
        </View>
        {/* With several sizes the badge on the card says "something here is low"; each size says which. A single size says it once. */}
        {group.lowCount > 0 && group.items.length > 1 ? <Badge tone="warning">{t("m.products.low")}</Badge> : null}
      </View>
      {group.items.map((i, n) => <SizeRow key={i.variantId} item={i} first={n === 0} />)}
    </Card>
  );
}

function SizeRow({ item, first }: { item: CatalogItem; first: boolean }) {
  const { t } = useI18n();
  const { colors } = useTheme();
  return (
    <View style={{ gap: 4, paddingTop: first ? 4 : 10, borderTopWidth: first ? 0 : 1, borderTopColor: colors.border }}>
      <View style={{ flexDirection: "row", justifyContent: "space-between", gap: 8 }}>
        <AppText style={{ fontWeight: "600", flexShrink: 1 }}>{item.size || item.sku}</AppText>
        <AppText variant="num">{item.sellingPrice ? formatLkr(item.sellingPrice) : t("cat.price.notSet")}</AppText>
      </View>
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
        {/* The size line already shows the SKU when a product has no size, so do not say it twice. */}
        {item.size ? <AppText variant="small" tone="muted">{item.sku}</AppText> : <View />}
        {item.low ? <Badge tone="warning">{t("m.products.low")}</Badge> : null}
      </View>
      <AppText variant="small" tone={item.lastCounted === null ? "muted" : undefined}>
        {item.lastCounted === null ? t("m.products.neverCounted") : t("m.products.lastCounted", { qty: `${qty(item.lastCounted)} ${item.baseUnit}` })}
        {item.low ? ` · ${t("dash.low.title")}: ≤ ${qty(item.lowStockLevel)}` : ""}
      </AppText>
      {item.packaging.length > 0 ? (
        <AppText variant="small" tone="muted">{`${t("m.products.packaging")}: ${item.packaging.join(" · ")}`}</AppText>
      ) : null}
    </View>
  );
}

function Frame({ children }: { children: React.ReactNode }) {
  const { colors } = useTheme();
  return <SafeAreaView style={{ flex: 1, backgroundColor: colors.bg }} edges={["top", "left", "right"]}>{children}</SafeAreaView>;
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
