"use client";

import { FormMessages, Field, SubmitButton, useActionForm } from "@/components/shared/form-bits";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/feedback";
import { FieldError, Label, Select } from "@/components/ui/input";
import { cancelInvitationAction, changeRoleAction, inviteMemberAction, resendInviteAction, setMemberStatusAction } from "@/server/actions/team";
import { ROLES, type Role } from "@/server/permissions";
import type { FormState } from "@/server/actions/auth";
import { useT } from "@/providers/i18n-provider";
import type { MessageKey } from "@/i18n";

const initial: FormState = {};
const Msg = ({ state }: { state: FormState }) => {
  const t = useT();
  return <>{state.error && <p role="alert" className="text-sm text-danger">{t(state.error)}</p>}{state.success && <p role="status" className="text-sm text-success">{t(state.success)}</p>}</>;
};

export function InviteForm({ serviceKeyReady }: { serviceKeyReady: boolean }) {
  const t = useT();
  const { state, onSubmit, pending } = useActionForm(inviteMemberAction, initial, { resetOnSuccess: true });
  return (
    <form onSubmit={onSubmit} className="grid gap-4 sm:max-w-xl" noValidate>
      {!serviceKeyReady && <Alert tone="warning">{t("team.noServiceKey")}</Alert>}
      <FormMessages state={state} />
      <Field name="email" label="team.email" state={state} type="email" autoComplete="off" required />
      <Field name="display_name" label="team.name" state={state} maxLength={80} autoComplete="off" />
      <fieldset>
        <legend className="mb-1.5 text-sm font-medium">{t("team.role")}</legend>
        <div className="space-y-2">
          {ROLES.map((r) => (
            <label key={r} className="flex min-h-11 cursor-pointer items-start gap-3 rounded-xl border border-border px-3.5 py-2.5 has-[:checked]:border-primary has-[:checked]:bg-mint">
              <input type="radio" name="role" value={r} defaultChecked={r === "stock_manager"} className="mt-1 size-4 accent-[var(--action)]" />
              <span>{t(`team.role.${r}` as MessageKey)}</span>
            </label>
          ))}
        </div>
        <FieldError>{state.fieldErrors?.role && t(state.fieldErrors.role)}</FieldError>
      </fieldset>
      <SubmitButton pending={pending}>{t("team.send")}</SubmitButton>
    </form>
  );
}

export function RoleSelect({ membershipId, role, label }: { membershipId: string; role: Role; label: string }) {
  const t = useT();
  const { state, onSubmit, pending } = useActionForm(changeRoleAction.bind(null, membershipId), initial);
  return (
    <form onSubmit={onSubmit} className="flex flex-wrap items-center gap-2">
      <Label htmlFor={`role-${membershipId}`} className="sr-only">{label}</Label>
      <Select id={`role-${membershipId}`} name="role" defaultValue={role} className="min-w-44 max-w-56">
        {ROLES.map((r) => <option key={r} value={r}>{t(`common.role.${r}` as MessageKey)}</option>)}
      </Select>
      <Button type="submit" variant="secondary" disabled={pending}>{t("common.save")}</Button>
      <Msg state={state} />
    </form>
  );
}

export function StatusButton({ membershipId, to, name }: { membershipId: string; to: "active" | "suspended"; name: string }) {
  const t = useT();
  const { state, onSubmit, pending } = useActionForm(setMemberStatusAction.bind(null, membershipId, to), initial);
  return (
    <form onSubmit={(e) => { if (to === "suspended" && !window.confirm(`${name}\n\n${t("team.confirmSuspend")}`)) { e.preventDefault(); return; } onSubmit(e); }} className="space-y-1">
      <Button type="submit" variant={to === "suspended" ? "danger" : "secondary"} disabled={pending}>{to === "suspended" ? t("team.suspend") : t("team.reactivate")}</Button>
      <Msg state={state} />
    </form>
  );
}

export function InvitationButtons({ membershipId, email }: { membershipId: string; email: string | null }) {
  const t = useT();
  const resend = useActionForm(resendInviteAction.bind(null, email ?? ""), initial);
  const cancel = useActionForm(cancelInvitationAction.bind(null, membershipId), initial);
  return (
    <div className="flex flex-wrap items-start gap-2">
      {email && <form onSubmit={resend.onSubmit}><Button type="submit" variant="secondary" disabled={resend.pending}>{t("team.resend")}</Button><Msg state={resend.state} /></form>}
      <form onSubmit={cancel.onSubmit}><Button type="submit" variant="ghost" disabled={cancel.pending}>{t("team.cancelInvite")}</Button><Msg state={cancel.state} /></form>
    </div>
  );
}
