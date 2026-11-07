"use client";

import { AlertTriangle, CheckCircle2, Info } from "lucide-react";
import { memo, useMemo } from "react";
import { Label, QuantityInput } from "@/components/ui/input";
import { BASE_KEY, describeQuantity, movementParts, type EntryItem, type FieldValues, type ItemState } from "@/features/inventory/count-entry";
import { resolveUnits } from "@/lib/calculations/packaging";
import { formatLkr } from "@/lib/formatting/money";
import { cn } from "@/lib/utils/cn";
import { useT } from "@/providers/i18n-provider";
import type { MessageKey } from "@/i18n";

interface Props {
  item: EntryItem;
  values: FieldValues;
  state: ItemState;
  disabled: boolean;
  onChange: (variantId: string, key: string, value: string) => void;
}

/** Move focus to the next/previous count field in the list (Enter / Shift+Enter). */
function moveFocus(current: HTMLInputElement, dir: 1 | -1) {
  const all = Array.from(document.querySelectorAll<HTMLInputElement>("[data-count-input]:not(:disabled)"));
  const next = all[all.indexOf(current) + dir];
  if (next) {
    next.focus();
    next.select();
    next.scrollIntoView({ block: "center", behavior: "smooth" });
  }
}

function ItemCardImpl({ item, values, state, disabled, onChange }: Props) {
  const t = useT();

  // Largest packaging unit first, then loose base units.
  const fields = useMemo(() => {
    const def = resolveUnits(item.units, item.baseUnit);
    const ordered = def.ok ? [...item.units].sort((a, b) => def.multipliers.get(b.id)!.comparedTo(def.multipliers.get(a.id)!)) : item.units;
    return [
      ...ordered.map((u) => ({
        key: u.id, packaged: true,
        label: u.name,
        hint: def.ok ? `× ${def.multipliers.get(u.id)!.toString()}` : "",
      })),
      { key: BASE_KEY, packaged: false, label: item.units.length ? t("pk.preview.loose", { unit: item.baseUnit }) : `${t("ms.enterRemaining")} (${item.baseUnit})`, hint: "" },
    ];
  }, [item.units, item.baseUnit, t]);

  const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") { e.preventDefault(); moveFocus(e.currentTarget, e.shiftKey ? -1 : 1); }
  };
  const onText = (key: string, packaged: boolean) => (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = e.target.value;
    // Whole numbers for bundles; up to 3 decimals for loose items. Anything else is ignored as typed.
    if (packaged ? /^\d{0,9}$/.test(v) : /^\d{0,12}(\.\d{0,3})?$/.test(v)) onChange(item.variantId, key, v);
  };

  const attention = state.kind === "error" || (state.kind === "counted" && state.flag === "increase");
  const counted = state.kind === "counted";

  return (
    <article
      id={`item-${item.variantId}`}
      className={cn(
        "rounded-[var(--radius-card)] border bg-surface p-4 shadow-soft transition-colors duration-150 sm:p-5",
        attention ? "border-warning" : counted ? "border-primary/50" : "border-border",
      )}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="text-lg font-semibold leading-snug">
            {item.productName} {item.sizeLabel && <span className="font-normal text-muted">{item.sizeLabel}</span>}
          </h3>
          <p className="num text-sm text-muted">{item.sku}{item.category ? ` · ${item.category}` : ""}</p>
        </div>
        <div className="text-right text-sm">
          <p className="text-muted">{t("ms.previous")}</p>
          <p className="num font-medium">
            {item.previousBase === null ? t("ms.previousNone") : describeQuantity(item.previousBase, item.units, item.baseUnit)}
          </p>
        </div>
      </div>

      {movementParts(item.movements).length > 0 && (
        <p className="num mt-2 text-sm text-muted">
          {t("ms.movementsIncluded")}: {movementParts(item.movements).map(([k, v]) => `${v} ${t(`mv.type.${k}` as MessageKey).toLowerCase()}`).join(" · ")}
        </p>
      )}

      <div className={cn("mt-4 grid gap-3", fields.length > 2 ? "grid-cols-2 sm:grid-cols-3" : fields.length === 2 ? "grid-cols-2" : "grid-cols-1")}>
        {fields.map((f) => {
          const id = `q-${item.variantId}-${f.key}`;
          return (
            <div key={f.key}>
              <Label htmlFor={id}>
                {f.label} {f.hint && <span className="num font-normal text-muted">{f.hint}</span>}
              </Label>
              <QuantityInput
                id={id}
                data-count-input
                inputMode={f.packaged ? "numeric" : "decimal"}
                enterKeyHint="next"
                autoComplete="off"
                value={values[f.key] ?? ""}
                disabled={disabled}
                placeholder="—"
                aria-invalid={state.kind === "error"}
                onChange={onText(f.key, f.packaged)}
                onKeyDown={onKey}
                onFocus={(e) => e.currentTarget.select()}
              />
            </div>
          );
        })}
      </div>

      <div className="mt-3 text-sm" aria-live="polite">
        {state.kind === "not_counted" && (
          <p className="flex items-start gap-2 text-muted"><Info className="mt-0.5 size-4 shrink-0" aria-hidden />{t("ms.notCounted")}</p>
        )}
        {state.kind === "error" && (
          <p role="alert" className="flex items-start gap-2 text-danger"><AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />{t(`pk.err.${state.code}` as MessageKey)}</p>
        )}
        {state.kind === "counted" && (
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-x-5 gap-y-1">
              <span className="num flex items-center gap-1.5 font-semibold"><CheckCircle2 className="size-4 text-primary" aria-hidden />{t("ms.total", { qty: state.baseQuantity, unit: item.baseUnit })}</span>
              {state.change !== null && (
                <span className="num text-muted">{t("ms.change")}: <span className="font-medium text-foreground">{Number(state.change) > 0 ? "+" : ""}{state.change}</span></span>
              )}
              {state.sales?.status === "calculated" && (
                <span className="num text-muted">{t("ms.estSold")}: <span className="font-medium text-foreground">{state.sales.unitsSold}</span></span>
              )}
              {state.estimatedValue !== null && (
                <span className="num text-muted">{t("ms.estSales")}: <span className="font-semibold text-foreground">{formatLkr(state.estimatedValue)}</span></span>
              )}
            </div>
            {state.flag === "increase" && (
              <p role="alert" className="flex items-start gap-2 text-warning"><AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />{t("ms.flag.increase")}</p>
            )}
            {state.flag === "no_previous" && <p className="flex items-start gap-2 text-muted"><Info className="mt-0.5 size-4 shrink-0" aria-hidden />{t("ms.flag.noPrevious")}</p>}
            {state.sales?.status === "calculated" && state.estimatedValue === null && <p className="text-muted">{t("ms.noPrice")}</p>}
          </div>
        )}
      </div>
    </article>
  );
}

export const ItemCard = memo(ItemCardImpl);
