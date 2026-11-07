"use client";

import { useState } from "react";
import { Alert } from "@/components/ui/feedback";
import { Card } from "@/components/ui/card";
import { Label, QuantityInput } from "@/components/ui/input";
import { calculateEstimatedSalesValue, calculateInferredUnitsSold } from "@/lib/calculations/inferred-sales";
import { useT } from "@/providers/i18n-provider";
import type { MessageKey } from "@/i18n";

const NUM = /^\d*\.?\d*$/;
const parse = (s: string): string | null => (s.trim() === "" || s === "." ? null : s);

/** Demo only: runs the real calculation engine in-browser and persists nothing. */
export function MorningStockCalculator() {
  const t = useT();
  const [v, setV] = useState({ opening: "100", received: "", damaged: "", closing: "72", price: "150" });
  const set = (k: keyof typeof v) => (e: React.ChangeEvent<HTMLInputElement>) => {
    if (NUM.test(e.target.value)) setV((s) => ({ ...s, [k]: e.target.value }));
  };

  const result = calculateInferredUnitsSold({
    opening: parse(v.opening),
    closing: parse(v.closing),
    received: parse(v.received) ?? 0,
    damaged: parse(v.damaged) ?? 0,
  });
  const price = parse(v.price);

  const fields: { k: keyof typeof v; label: MessageKey }[] = [
    { k: "opening", label: "m.calc.opening" },
    { k: "received", label: "m.calc.received" },
    { k: "damaged", label: "m.calc.damaged" },
    { k: "closing", label: "m.calc.closing" },
    { k: "price", label: "m.calc.price" },
  ];

  return (
    <Card className="grid gap-6 p-6 md:grid-cols-2 md:p-8">
      <div className="grid grid-cols-2 gap-4">
        {fields.map(({ k, label }) => (
          <div key={k} className={k === "price" ? "col-span-2" : undefined}>
            <Label htmlFor={`calc-${k}`}>{t(label)}</Label>
            <QuantityInput id={`calc-${k}`} value={v[k]} onChange={set(k)} placeholder="—" />
          </div>
        ))}
      </div>

      <div className="flex flex-col justify-center gap-4 rounded-2xl bg-surface-soft p-5" aria-live="polite">
        {result.status === "pending" && <Alert tone="info">{t("m.calc.pending")}</Alert>}
        {result.status === "needs_review" && (
          <Alert tone="warning">{result.reason === "negative_sales" ? t("m.calc.review") : t("m.calc.invalid")}</Alert>
        )}
        {result.status === "calculated" && (
          <>
            <div>
              <p className="text-sm text-muted">{t("m.calc.units")}</p>
              <p className="num text-4xl font-semibold">{result.unitsSold}</p>
            </div>
            <div>
              <p className="text-sm text-muted">{t("m.calc.value")}</p>
              <p className="num text-4xl font-semibold text-action dark:text-primary">
                {price ? `Rs. ${Number(calculateEstimatedSalesValue(result.unitsSold, price)).toLocaleString("en-LK", { minimumFractionDigits: 2 })}` : "—"}
              </p>
            </div>
            <p className="text-sm text-muted">{t("m.calc.forDate")}</p>
          </>
        )}
        <p className="text-xs text-muted">{t("m.calc.disclaimer")}</p>
      </div>
    </Card>
  );
}
