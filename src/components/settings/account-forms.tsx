"use client";

import { Field, FormMessages, SubmitButton, useActionForm } from "@/components/shared/form-bits";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/feedback";
import { FieldError, Label, Select } from "@/components/ui/input";
import { LOCALES, LOCALE_LABELS } from "@/i18n";
import { changePasswordAction, signOutOtherDevicesAction, updateProfileAction, updateShopAction } from "@/server/actions/settings";
import type { FormState } from "@/server/actions/auth";
import { useT } from "@/providers/i18n-provider";
import type { MessageKey } from "@/i18n";

const initial: FormState = {};

export function ProfileForm({ displayName, language }: { displayName: string; language: "en" | "si" }) {
  const t = useT();
  const { state, onSubmit, pending } = useActionForm(updateProfileAction, initial);
  return (
    <form onSubmit={onSubmit} className="grid gap-4 sm:max-w-md" noValidate>
      <FormMessages state={state} />
      <Field name="display_name" label="prof.name" state={state} defaultValue={displayName} maxLength={80} autoComplete="name" required />
      <div>
        <Label htmlFor="preferred_language">{t("prof.language")}</Label>
        <Select id="preferred_language" name="preferred_language" defaultValue={language}>
          {LOCALES.map((l) => <option key={l} value={l} lang={l}>{LOCALE_LABELS[l]}</option>)}
        </Select>
        <FieldError>{state.fieldErrors?.preferred_language && t(state.fieldErrors.preferred_language)}</FieldError>
      </div>
      <SubmitButton pending={pending}>{t("prof.save")}</SubmitButton>
    </form>
  );
}

export function PasswordForm() {
  const t = useT();
  const { state, onSubmit, pending } = useActionForm(changePasswordAction, initial, { resetOnSuccess: true });
  return (
    <form onSubmit={onSubmit} className="grid gap-4 sm:max-w-md" noValidate>
      <FormMessages state={state} />
      <Field name="password" label="prof.newPassword" state={state} type="password" autoComplete="new-password" minLength={10} required />
      <Field name="confirm" label="auth.update.confirm" state={state} type="password" autoComplete="new-password" required />
      <SubmitButton pending={pending}>{t("prof.changePassword")}</SubmitButton>
    </form>
  );
}

export function SignOutOthers() {
  const t = useT();
  const { state, onSubmit, pending } = useActionForm(signOutOtherDevicesAction, initial);
  return (
    <form onSubmit={onSubmit} className="space-y-2 sm:max-w-md">
      {state.error && <Alert tone="danger">{t(state.error)}</Alert>}
      {state.success && <Alert tone="success">{t(state.success)}</Alert>}
      <Button type="submit" variant="secondary" disabled={pending}>{t("prof.signOutOthers")}</Button>
      <p className="text-sm text-muted">{t("prof.signOutOthersHint")}</p>
    </form>
  );
}

export function ShopSettingsForm({ name, timezone, timezones, timezoneLocked, policy }: {
  name: string; timezone: string; timezones: string[]; timezoneLocked: boolean; policy: "cost_at_count" | "latest_cost";
}) {
  const t = useT();
  const { state, onSubmit, pending } = useActionForm(updateShopAction, initial);
  const tzErr = state.fieldErrors?.timezone;
  return (
    <form onSubmit={onSubmit} className="grid gap-5 sm:max-w-xl" noValidate>
      <FormMessages state={state} />
      <Field name="name" label="set.shop.name" state={state} defaultValue={name} maxLength={80} required />
      <div>
        <Label htmlFor="currency">{t("set.shop.currency")}</Label>
        <input id="currency" value="LKR" readOnly aria-describedby="currency-note" className="min-h-11 w-full rounded-xl border border-border bg-surface-soft px-3.5 text-muted" />
        <p id="currency-note" className="mt-1 text-xs text-muted">{t("set.shop.currencyNote")}</p>
      </div>
      <div>
        <Label htmlFor="timezone">{t("set.shop.timezone")}</Label>
        <Select id="timezone" name="timezone" defaultValue={timezone} disabled={timezoneLocked} aria-invalid={!!tzErr} aria-describedby="tz-note">
          {timezones.map((z) => <option key={z} value={z}>{z}</option>)}
        </Select>
        {/* a disabled control is not submitted: keep the current value so the save still carries it */}
        {timezoneLocked && <input type="hidden" name="timezone" value={timezone} />}
        <FieldError>{tzErr && t(tzErr)}</FieldError>
        {timezoneLocked && <p id="tz-note" className="mt-1 text-xs text-muted">{t("set.shop.timezoneLocked")}</p>}
      </div>
      <fieldset>
        <legend className="mb-1.5 text-sm font-medium">{t("set.shop.valuation")}</legend>
        <div className="space-y-2">
          {(["cost_at_count", "latest_cost"] as const).map((p) => (
            <label key={p} className="flex min-h-11 cursor-pointer items-start gap-3 rounded-xl border border-border px-3.5 py-2.5 has-[:checked]:border-primary has-[:checked]:bg-mint">
              <input type="radio" name="valuation_policy" value={p} defaultChecked={policy === p} className="mt-1 size-4 accent-[var(--action)]" />
              <span><span className="block font-medium">{t(`set.shop.valuation.${p}` as MessageKey)}</span><span className="block text-sm text-muted">{t(`set.shop.valuation.${p}.hint` as MessageKey)}</span></span>
            </label>
          ))}
        </div>
        <FieldError>{state.fieldErrors?.valuation_policy && t(state.fieldErrors.valuation_policy)}</FieldError>
      </fieldset>
      <SubmitButton pending={pending}>{t("set.shop.save")}</SubmitButton>
    </form>
  );
}
