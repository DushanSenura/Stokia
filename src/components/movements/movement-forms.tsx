"use client";

import { useState } from "react";
import { VariantPicker } from "@/components/movements/variant-picker";
import { FormMessages, SubmitButton, useActionForm } from "@/components/shared/form-bits";
import { Alert } from "@/components/ui/feedback";
import { Button } from "@/components/ui/button";
import { FieldError, Input, Label, QuantityInput, Select } from "@/components/ui/input";
import { recordMovementAction, recordRepackingAction, reverseMovementAction } from "@/server/actions/movements";
import type { FormState } from "@/server/actions/auth";
import { useT } from "@/providers/i18n-provider";
import type { VariantHit } from "@/app/api/variants/search/route";
import type { MessageKey } from "@/i18n";

const initial: FormState = {};
const TYPES = ["stock_received", "customer_return", "supplier_return", "damaged", "expired", "discarded", "manual_adjustment"] as const;
const newKey = () => crypto.randomUUID();

/**
 * One idempotency key per "attempt": it only changes after a SUCCESSFUL save, so a retry of a failed or
 * timed-out submission re-sends the same key and can never record the movement twice.
 */
function useIdempotencyKey(state: FormState) {
  const [key, setKey] = useState(newKey);
  const [seen, setSeen] = useState(state);
  if (state !== seen) { setSeen(state); if (state.success) setKey(newKey()); }
  return key;
}

function Err({ state, name }: { state: FormState; name: string }) {
  const t = useT();
  const e = state.fieldErrors?.[name];
  return <FieldError>{e && t(e)}</FieldError>;
}

/** Quantity + unit (packaging units first, then the base unit). */
function QuantityWithUnit({ hit, prefix, state, label = "mv.form.quantity" }: { hit: VariantHit | null; prefix: string; state: FormState; label?: MessageKey }) {
  const t = useT();
  const qName = prefix ? `${prefix}_quantity` : "quantity";
  const uName = prefix ? `${prefix}_unit` : "unit_id";
  const err = state.fieldErrors?.[qName];
  return (
    <div className="grid grid-cols-[1fr_auto] gap-3">
      <div>
        <Label htmlFor={qName}>{t(label)}</Label>
        <QuantityInput id={qName} name={qName} required aria-invalid={!!err} />
        <Err state={state} name={qName} />
      </div>
      <div className="min-w-32">
        <Label htmlFor={uName}>{t("mv.form.unit")}</Label>
        <Select id={uName} name={uName} disabled={!hit} defaultValue="" key={hit?.id ?? "none"}>
          <option value="">{hit?.baseUnit ?? "—"}</option>
          {hit?.units.map((u) => <option key={u.id} value={u.id}>{u.name} (× {u.multiplier})</option>)}
        </Select>
      </div>
    </div>
  );
}

function WhenFields({ state, defaultLocal, allowBefore }: { state: FormState; defaultLocal: string; allowBefore: boolean }) {
  const t = useT();
  const [when, setWhen] = useState("now");
  const opts = [{ v: "now", k: "mv.when.now" as const }, ...(allowBefore ? [{ v: "before_count", k: "mv.when.before" as const }] : []), { v: "custom", k: "mv.when.custom" as const }];
  return (
    <fieldset className="space-y-2">
      <legend className="mb-1.5 text-sm font-medium">{t("mv.form.when")}</legend>
      {opts.map((o) => (
        <label key={o.v} className="flex min-h-11 cursor-pointer items-start gap-3 rounded-xl border border-border px-3.5 py-2.5 has-[:checked]:border-primary has-[:checked]:bg-mint">
          <input type="radio" name="when" value={o.v} checked={when === o.v} onChange={() => setWhen(o.v)} className="mt-1 size-4 accent-[var(--action)]" />
          <span>{t(o.k)}</span>
        </label>
      ))}
      {when === "custom" && (
        <div>
          <Label htmlFor="effective_local">{t("mv.form.time")}</Label>
          <Input id="effective_local" name="effective_local" type="datetime-local" defaultValue={defaultLocal} />
          <Err state={state} name="effective_local" />
        </div>
      )}
      <Err state={state} name="when" />
      <p className="text-xs text-muted">{t("mv.timingHelp")}</p>
    </fieldset>
  );
}

export function MovementForm({ defaultLocal }: { defaultLocal: string }) {
  const t = useT();
  const { state, onSubmit, pending } = useActionForm(recordMovementAction, initial, { resetOnSuccess: true });
  const key = useIdempotencyKey(state);
  const [hit, setHit] = useState<VariantHit | null>(null);
  const [type, setType] = useState<(typeof TYPES)[number]>("stock_received");

  return (
    <form onSubmit={onSubmit} className="space-y-5" noValidate>
      <FormMessages state={state} />
      <input type="hidden" name="key" value={key} />
      <VariantPicker name="variant_id" label="mv.form.product" error={state.fieldErrors?.variant_id} selected={hit} onPick={setHit} />
      <div>
        <Label htmlFor="type">{t("mv.form.type")}</Label>
        <Select id="type" name="type" value={type} onChange={(e) => setType(e.target.value as (typeof TYPES)[number])}>
          {TYPES.map((x) => <option key={x} value={x}>{t(`mv.type.${x}` as MessageKey)}</option>)}
        </Select>
        <Err state={state} name="type" />
      </div>
      {type === "manual_adjustment" && (
        <fieldset className="flex flex-wrap gap-3">
          <legend className="mb-1.5 text-sm font-medium">{t("mv.form.direction")}</legend>
          {(["in", "out"] as const).map((d) => (
            <label key={d} className="flex min-h-11 flex-1 cursor-pointer items-center gap-3 rounded-xl border border-border px-3.5 has-[:checked]:border-primary has-[:checked]:bg-mint">
              <input type="radio" name="direction" value={d} className="size-4 accent-[var(--action)]" /> {t(`mv.dir.${d}` as MessageKey)}
            </label>
          ))}
          <Err state={state} name="direction" />
        </fieldset>
      )}
      <QuantityWithUnit hit={hit} prefix="" state={state} />
      <WhenFields state={state} defaultLocal={defaultLocal} allowBefore />
      <div>
        <Label htmlFor="reason">{t("mv.form.reason")}</Label>
        <Input id="reason" name="reason" maxLength={300} />
        <Err state={state} name="reason" />
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div><Label htmlFor="reference">{t("mv.form.reference")}</Label><Input id="reference" name="reference" maxLength={120} /></div>
        {(type === "stock_received" || type === "supplier_return") && (
          <div><Label htmlFor="supplier">{t("mv.form.supplier")}</Label><Input id="supplier" name="supplier" maxLength={120} /></div>
        )}
      </div>
      {type === "stock_received" && (
        <div className="sm:max-w-xs"><Label htmlFor="cost">{t("mv.form.cost")}</Label><Input id="cost" name="cost" inputMode="decimal" /><Err state={state} name="cost" /></div>
      )}
      <div className="sm:max-w-xs"><SubmitButton pending={pending}>{t("mv.form.submit")}</SubmitButton></div>
    </form>
  );
}

export function RepackForm({ defaultLocal }: { defaultLocal: string }) {
  const t = useT();
  const { state, onSubmit, pending } = useActionForm(recordRepackingAction, initial, { resetOnSuccess: true });
  const key = useIdempotencyKey(state);
  const [from, setFrom] = useState<VariantHit | null>(null);
  const [to, setTo] = useState<VariantHit | null>(null);
  return (
    <form onSubmit={onSubmit} className="space-y-6" noValidate>
      <FormMessages state={state} />
      <input type="hidden" name="key" value={key} />
      <div className="space-y-4 rounded-2xl border border-border p-4">
        <VariantPicker name="from_variant" label="mv.repack.from" error={state.fieldErrors?.from_variant} selected={from} onPick={setFrom} />
        <QuantityWithUnit hit={from} prefix="from" state={state} />
      </div>
      <div className="space-y-4 rounded-2xl border border-border p-4">
        <VariantPicker name="to_variant" label="mv.repack.to" error={state.fieldErrors?.to_variant} selected={to} onPick={setTo} />
        <QuantityWithUnit hit={to} prefix="to" state={state} />
      </div>
      <WhenFields state={state} defaultLocal={defaultLocal} allowBefore={false} />
      <div><Label htmlFor="reason">{t("mv.form.reason")}</Label><Input id="reason" name="reason" maxLength={300} required /><Err state={state} name="reason" /></div>
      <div className="sm:max-w-xs"><SubmitButton pending={pending}>{t("mv.repack.submit")}</SubmitButton></div>
    </form>
  );
}

export function ReverseForm({ movementId }: { movementId: string }) {
  const t = useT();
  const { state, onSubmit, pending } = useActionForm(reverseMovementAction.bind(null, movementId), initial);
  const key = useIdempotencyKey(state);
  return (
    <details className="group">
      <summary className="flex min-h-11 cursor-pointer items-center text-sm font-medium text-action underline-offset-4 hover:underline dark:text-sage">{t("mv.reverse")}</summary>
      <form onSubmit={onSubmit} className="mt-2 w-72 max-w-full space-y-2" noValidate>
        <Alert tone="info">{t("mv.reverse.body")}</Alert>
        {state.error && <Alert tone="danger">{t(state.error)}</Alert>}
        {state.success && <Alert tone="success">{t(state.success)}</Alert>}
        <input type="hidden" name="key" value={key} />
        <Label htmlFor={`rv-${movementId}`}>{t("mv.reverse.reason")}</Label>
        <Input id={`rv-${movementId}`} name="reason" maxLength={300} required />
        <Err state={state} name="reason" />
        <Button type="submit" variant="secondary" disabled={pending}>{t("mv.reverse.submit")}</Button>
      </form>
    </details>
  );
}
