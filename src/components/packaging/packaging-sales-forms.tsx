"use client";

import { FormMessages, SubmitButton, useActionForm } from "@/components/shared/form-bits";
import { FieldError, Input, Label } from "@/components/ui/input";
import { setBaseUnitSellableAction, setPackagingPriceAction, updatePackagingUseAction } from "@/server/actions/packaging";
import type { FormState } from "@/server/actions/auth";
import { useT } from "@/providers/i18n-provider";

const initial: FormState = {};

function Check({ name, label, defaultChecked, id }: { name: string; label: string; defaultChecked: boolean; id: string }) {
  return (
    <label htmlFor={id} className="flex min-h-11 cursor-pointer items-center gap-3 text-[15px]">
      <input id={id} type="checkbox" name={name} defaultChecked={defaultChecked} className="size-5 accent-[var(--action)]" />
      {label}
    </label>
  );
}

/** What a unit is for: counted, sold, or both. Prices and history are untouched by this. */
export function PackagingUseForm({ variantId, unitId, canBeSold, canBeCounted }: { variantId: string; unitId: string; canBeSold: boolean; canBeCounted: boolean }) {
  const t = useT();
  const { state, onSubmit, pending } = useActionForm(updatePackagingUseAction.bind(null, variantId, unitId), initial);
  return (
    <form onSubmit={onSubmit} className="space-y-2" noValidate>
      <FormMessages state={state} />
      <Check id={`sold-${unitId}`} name="can_be_sold" label={t("pk.use.sold")} defaultChecked={canBeSold} />
      <Check id={`counted-${unitId}`} name="can_be_counted" label={t("pk.use.counted")} defaultChecked={canBeCounted} />
      <p className="text-xs text-muted">{t("pk.use.help")}</p>
      <div className="max-w-xs"><SubmitButton pending={pending}>{t("pk.use.save")}</SubmitButton></div>
    </form>
  );
}

/**
 * A new selling price for a sellable unit, from a date on. The old price period is closed, never edited.
 * Several units can sit on one page, so every id here is unique per unit (a shared id would make a label point at another unit's field).
 */
export function PackagingPriceForm({ variantId, unitId }: { variantId: string; unitId: string }) {
  const t = useT();
  const { state, onSubmit, pending } = useActionForm(setPackagingPriceAction.bind(null, variantId, unitId), initial, { resetOnSuccess: true });
  const amountErr = state.fieldErrors?.amount, fromErr = state.fieldErrors?.effective_from;
  const amountId = `price-amount-${unitId}`, fromId = `price-from-${unitId}`;
  return (
    <form onSubmit={onSubmit} className="grid gap-4 sm:grid-cols-2" noValidate>
      <div className="sm:col-span-2"><FormMessages state={state} /></div>
      <div>
        <Label htmlFor={amountId}>{t("pk.price.amount")}</Label>
        <Input id={amountId} name="amount" inputMode="decimal" autoComplete="off" required aria-invalid={!!amountErr} aria-describedby={amountErr ? `${amountId}-err` : undefined} />
        <FieldError id={`${amountId}-err`}>{amountErr && t(amountErr)}</FieldError>
      </div>
      <div>
        <Label htmlFor={fromId}>{t("pk.price.from")}</Label>
        <Input id={fromId} name="effective_from" type="date" aria-invalid={!!fromErr} aria-describedby={fromErr ? `${fromId}-err` : `${fromId}-help`} />
        <p id={`${fromId}-help`} className="mt-1 text-xs text-muted">{t("pk.price.fromHelp")}</p>
        <FieldError id={`${fromId}-err`}>{fromErr && t(fromErr)}</FieldError>
      </div>
      <div className="sm:col-span-2 sm:max-w-xs"><SubmitButton pending={pending}>{t("pk.price.save")}</SubmitButton></div>
    </form>
  );
}

/** Whether the unit you count in (e.g. "piece") is itself sold. Its price is the variant's own selling price. */
export function BaseUnitSellableForm({ variantId, sellable }: { variantId: string; sellable: boolean }) {
  const t = useT();
  const { state, onSubmit, pending } = useActionForm(setBaseUnitSellableAction.bind(null, variantId), initial);
  return (
    <form onSubmit={onSubmit} className="space-y-2" noValidate>
      <FormMessages state={state} />
      <Check id={`base-sold-${variantId}`} name="base_unit_sellable" label={t("pk.base.sold")} defaultChecked={sellable} />
      <div className="max-w-xs"><SubmitButton pending={pending}>{t("pk.use.save")}</SubmitButton></div>
    </form>
  );
}
