"use client";

import { Field, FormMessages, SubmitButton, useActionForm } from "@/components/shared/form-bits";
import { Button } from "@/components/ui/button";
import { FieldError, Label, Select } from "@/components/ui/input";
import { Alert } from "@/components/ui/feedback";
import { createPackagingUnitAction, setPackagingUnitActiveAction, updatePackagingUnitAction } from "@/server/actions/packaging";
import type { FormState } from "@/server/actions/auth";
import { useT } from "@/providers/i18n-provider";

const initial: FormState = {};
const PRESETS = ["Bundle", "Carton", "Box", "Case", "Tray", "Pack", "Dozen"];

export interface UnitOption { id: string; name: string }

/** Create (no `unit`) or edit a packaging unit. `locked` = used by recorded movements, so size can't change. */
export function PackagingUnitForm({
  variantId, baseUnit, unit, options, locked,
}: {
  variantId: string;
  baseUnit: string;
  unit?: { id: string; name: string; parent_unit_id: string | null; conversion_factor: string };
  options: UnitOption[]; // other active units this one could be built from
  locked?: boolean;
}) {
  const t = useT();
  const action = unit ? updatePackagingUnitAction.bind(null, variantId, unit.id) : createPackagingUnitAction.bind(null, variantId);
  const { state, onSubmit, pending } = useActionForm(action, initial, { resetOnSuccess: !unit });
  const parentErr = state.fieldErrors?.parent_unit_id;
  const listId = `presets-${unit?.id ?? "new"}`;
  const id = (n: string) => `${n}-${unit?.id ?? "new"}`;

  return (
    <form onSubmit={onSubmit} className="grid gap-4 sm:grid-cols-3" noValidate>
      <div className="sm:col-span-3"><FormMessages state={state} /></div>
      {locked && <div className="sm:col-span-3"><Alert tone="warning">{t("pk.lockedNote")}</Alert></div>}
      <div>
        <Field name="name" label="pk.name" state={state} defaultValue={unit?.name} list={listId} placeholder={t("pk.nameHint")} maxLength={40} required />
        <datalist id={listId}>{PRESETS.map((p) => <option key={p} value={p} />)}</datalist>
      </div>
      <div>
        <Label htmlFor={id("parent_unit_id")}>{t("pk.madeOf")}</Label>
        <Select id={id("parent_unit_id")} name="parent_unit_id" defaultValue={unit?.parent_unit_id ?? ""} disabled={locked} aria-invalid={!!parentErr}>
          <option value="">{t("pk.baseOption", { unit: baseUnit })}</option>
          {options.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
        </Select>
        {/* disabled controls are not submitted: keep the current value when locked */}
        {locked && <input type="hidden" name="parent_unit_id" value={unit?.parent_unit_id ?? ""} />}
        <FieldError>{parentErr && t(parentErr)}</FieldError>
      </div>
      <div>
        <Field name="conversion_factor" label="pk.factor" state={state} defaultValue={unit ? String(Number(unit.conversion_factor)) : ""} inputMode="decimal" readOnly={locked} required />
        <p className="mt-1 text-xs text-muted">{t("pk.factorHint")}</p>
      </div>
      <div className="sm:col-span-3 sm:max-w-xs"><SubmitButton pending={pending}>{unit ? t("cat.form.saveChanges") : t("pk.add")}</SubmitButton></div>
    </form>
  );
}

export function UnitActiveButton({ variantId, unitId, active }: { variantId: string; unitId: string; active: boolean }) {
  const t = useT();
  const { state, onSubmit, pending } = useActionForm(setPackagingUnitActiveAction.bind(null, variantId, unitId, !active), initial);
  return (
    <form onSubmit={onSubmit} className="space-y-2">
      {state.error && <Alert tone="danger">{t(state.error)}</Alert>}
      <Button type="submit" variant="ghost" disabled={pending}>{active ? t("pk.deactivate") : t("pk.activate")}</Button>
    </form>
  );
}
