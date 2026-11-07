"use client";

import Link from "next/link";
import {
  createShopAction,
  requestPasswordResetAction,
  signInAction,
  updatePasswordAction,
  type FormState,
} from "@/server/actions/auth";
import { Field, FormMessages, SubmitButton, useActionForm } from "@/components/shared/form-bits";
import { useT } from "@/providers/i18n-provider";
import { Label } from "@/components/ui/input";

const initial: FormState = {};

export function LoginForm({ next }: { next?: string }) {
  const t = useT();
  const { state, onSubmit, pending } = useActionForm(signInAction, initial);
  return (
    <form onSubmit={onSubmit} className="space-y-4" noValidate>
      <FormMessages state={state} />
      <input type="hidden" name="next" value={next ?? ""} />
      <Field name="email" label="auth.email" state={state} type="email" autoComplete="email" required />
      <Field name="password" label="auth.password" state={state} type="password" autoComplete="current-password" required />
      <SubmitButton pending={pending}>{t("common.signIn")}</SubmitButton>
      <p className="text-center text-sm">
        <Link href="/reset-password" className="text-action underline-offset-4 hover:underline dark:text-sage">
          {t("auth.forgot")}
        </Link>
      </p>
    </form>
  );
}

export function ResetRequestForm() {
  const t = useT();
  const { state, onSubmit, pending } = useActionForm(requestPasswordResetAction, initial);
  return (
    <form onSubmit={onSubmit} className="space-y-4" noValidate>
      <FormMessages state={state} />
      <Field name="email" label="auth.email" state={state} type="email" autoComplete="email" required />
      <SubmitButton pending={pending}>{t("auth.reset.send")}</SubmitButton>
      <p className="text-center text-sm">
        <Link href="/login" className="text-action underline-offset-4 hover:underline dark:text-sage">
          {t("auth.reset.back")}
        </Link>
      </p>
    </form>
  );
}

export function UpdatePasswordForm() {
  const t = useT();
  const { state, onSubmit, pending } = useActionForm(updatePasswordAction, initial);
  return (
    <form onSubmit={onSubmit} className="space-y-4" noValidate>
      <FormMessages state={state} />
      <Field name="password" label="auth.password" state={state} type="password" autoComplete="new-password" required minLength={10} />
      <Field name="confirm" label="auth.update.confirm" state={state} type="password" autoComplete="new-password" required />
      <SubmitButton pending={pending}>{t("auth.update.submit")}</SubmitButton>
    </form>
  );
}

export function SetupShopForm({ defaultTimezone }: { defaultTimezone: string }) {
  const t = useT();
  const { state, onSubmit, pending } = useActionForm(createShopAction, initial);
  return (
    <form onSubmit={onSubmit} className="space-y-4" noValidate>
      <FormMessages state={state} />
      <Field name="name" label="setup.shopName" state={state} placeholder={t("setup.shopNameHint")} autoComplete="organization" required />
      <div>
        <Label htmlFor="currency">{t("setup.currency")}</Label>
        <input id="currency" name="currency" value="LKR" readOnly className="min-h-11 w-full rounded-xl border border-border bg-surface-soft px-3.5 text-muted" />
      </div>
      <input type="hidden" name="timezone" value={defaultTimezone} />
      <p className="text-sm text-muted">
        {t("setup.timezone")}: <span className="font-medium text-foreground">{defaultTimezone}</span>
      </p>
      <SubmitButton pending={pending}>{t("setup.submit")}</SubmitButton>
    </form>
  );
}
