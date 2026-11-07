"use client";

import { useMemo, useState } from "react";
import { Alert } from "@/components/ui/feedback";
import { Card } from "@/components/ui/card";
import { Label, QuantityInput } from "@/components/ui/input";
import { denormalizeQuantity, normalizePackagingQuantity, resolveUnits, type PackUnit } from "@/lib/calculations/packaging";
import { useT } from "@/providers/i18n-provider";
import type { MessageKey } from "@/i18n";

const NUM = /^\d*\.?\d*$/;

/**
 * Live preview using the SAME engine the morning-stock form will use. Nothing is saved.
 * Shows both directions: entered counts -> total, and total -> bundles + loose.
 */
export function ConversionPreview({ units, baseUnit }: { units: PackUnit[]; baseUnit: string }) {
  const t = useT();
  const active = useMemo(() => units.filter((u) => u.isActive !== false), [units]);
  const def = useMemo(() => resolveUnits(active, baseUnit), [active, baseUnit]);
  const ordered = useMemo(
    () => (def.ok ? [...active].sort((a, b) => def.multipliers.get(b.id)!.comparedTo(def.multipliers.get(a.id)!)) : active),
    [active, def],
  );
  const [counts, setCounts] = useState<Record<string, string>>({});
  const [total, setTotal] = useState("");
  const set = (k: string, v: string) => NUM.test(v) && setCounts((s) => ({ ...s, [k]: v }));

  const result = normalizePackagingQuantity(
    [...ordered.map((u) => ({ unitId: u.id as string | null, quantity: counts[u.id] })), { unitId: null, quantity: counts.__base }],
    active, baseUnit,
  );
  const name = (id: string | null) => (id === null ? baseUnit : active.find((u) => u.id === id)?.name ?? "");
  const breakdown = total && /^\d*\.?\d+$/.test(total) ? denormalizeQuantity(total, active) : null;

  return (
    <Card className="space-y-6" aria-labelledby="preview-h">
      <h2 id="preview-h" className="text-xl font-semibold">{t("pk.preview.title")}</h2>
      {!def.ok && <Alert tone="danger">{t(`pk.err.definition_invalid` as MessageKey)}</Alert>}

      <div className="grid gap-6 md:grid-cols-2">
        <div className="space-y-3">
          <h3 className="font-medium">{t("pk.preview.count")}</h3>
          <div className="grid grid-cols-2 gap-3">
            {ordered.map((u) => (
              <div key={u.id}>
                <Label htmlFor={`pv-${u.id}`}>{u.name}</Label>
                <QuantityInput id={`pv-${u.id}`} inputMode="numeric" value={counts[u.id] ?? ""} onChange={(e) => set(u.id, e.target.value)} placeholder="—" />
              </div>
            ))}
            <div>
              <Label htmlFor="pv-base">{t("pk.preview.loose", { unit: baseUnit })}</Label>
              <QuantityInput id="pv-base" value={counts.__base ?? ""} onChange={(e) => set("__base", e.target.value)} placeholder="—" />
            </div>
          </div>
          <div className="rounded-2xl bg-surface-soft p-4" aria-live="polite">
            {!result.ok && result.code === "definition_invalid" ? (
              <p className="text-muted">—</p> /* already explained by the banner above */
            ) : !result.ok ? (
              <p className="text-danger" role="alert">{t(`pk.err.${result.code}` as MessageKey)}</p>
            ) : !result.counted ? (
              <p className="text-muted">{t("pk.preview.notCounted")}</p>
            ) : (
              <>
                <p className="text-sm text-muted">{t("pk.preview.total", { unit: baseUnit })}</p>
                <p className="num text-3xl font-semibold">{result.baseQuantity}</p>
                <p className="num mt-1 text-sm text-muted">
                  {result.lines.filter((l) => l.unitId !== null).map((l) => `${l.quantity} ${name(l.unitId)} = ${l.baseQuantity}`).join(" + ")}
                </p>
              </>
            )}
          </div>
        </div>

        <div className="space-y-3">
          <h3 className="font-medium">{t("pk.preview.reverse")}</h3>
          <div>
            <Label htmlFor="pv-total">{t("pk.preview.reverseInput", { unit: baseUnit })}</Label>
            <QuantityInput id="pv-total" value={total} onChange={(e) => NUM.test(e.target.value) && setTotal(e.target.value)} placeholder="—" />
          </div>
          <div className="rounded-2xl bg-surface-soft p-4" aria-live="polite">
            {breakdown ? (
              <p className="num text-2xl font-semibold">
                {breakdown.map((b) => `${b.quantity} ${name(b.unitId)}`).join(" + ")}
              </p>
            ) : (
              <p className="text-muted">{t("pk.preview.reverseHint")}</p>
            )}
          </div>
        </div>
      </div>
    </Card>
  );
}
