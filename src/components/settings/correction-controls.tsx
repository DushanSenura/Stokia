"use client";

import { useMemo } from "react";
import { FormMessages, SubmitButton, useActionForm } from "@/components/shared/form-bits";
import { Alert } from "@/components/ui/feedback";
import { Button } from "@/components/ui/button";
import { FieldError, Input, Label, QuantityInput } from "@/components/ui/input";
import { resolveUnits, type PackUnit } from "@/lib/calculations/packaging";
import { cancelCorrectionAction, decideCorrectionAction, requestCorrectionAction } from "@/server/actions/corrections";
import type { FormState } from "@/server/actions/auth";
import { useT } from "@/providers/i18n-provider";
import type { MessageKey } from "@/i18n";

const initial: FormState = {};

/** The same bundle + loose entry used for morning counts: totals are recomputed on the server from the stored packaging. */
export function CorrectionForm({ sessionId, variantId, units, baseUnit, isOwner, idPrefix }: {
  sessionId: string; variantId: string; units: PackUnit[]; baseUnit: string; isOwner: boolean; idPrefix: string;
}) {
  const t = useT();
  const { state, onSubmit, pending } = useActionForm(requestCorrectionAction.bind(null, sessionId, variantId), initial, { resetOnSuccess: true });
  const ordered = useMemo(() => {
    const def = resolveUnits(units, baseUnit);
    return def.ok ? [...units].sort((a, b) => def.multipliers.get(b.id)!.comparedTo(def.multipliers.get(a.id)!)) : units;
  }, [units, baseUnit]);
  const qErr = state.fieldErrors?.quantity;
  const rErr = state.fieldErrors?.reason;

  return (
    <form onSubmit={onSubmit} className="space-y-3" noValidate>
      <FormMessages state={state} />
      <Alert tone="info">{isOwner ? t("cor.ownerNote") : t("cor.managerNote")}</Alert>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        {ordered.map((u) => (
          <div key={u.id}>
            <Label htmlFor={`${idPrefix}-${u.id}`}>{u.name}</Label>
            <QuantityInput id={`${idPrefix}-${u.id}`} name={`q:${u.id}`} inputMode="numeric" placeholder="—" autoComplete="off" aria-invalid={!!qErr} />
          </div>
        ))}
        <div>
          <Label htmlFor={`${idPrefix}-base`}>{units.length ? t("pk.preview.loose", { unit: baseUnit }) : `${t("cor.newQuantity")} (${baseUnit})`}</Label>
          <QuantityInput id={`${idPrefix}-base`} name="q:base" placeholder="—" autoComplete="off" aria-invalid={!!qErr} />
        </div>
      </div>
      <FieldError>{qErr && t(qErr)}</FieldError>
      <div>
        <Label htmlFor={`${idPrefix}-reason`}>{t("cor.reason")}</Label>
        <Input id={`${idPrefix}-reason`} name="reason" maxLength={300} placeholder={t("cor.reasonHint")} aria-invalid={!!rErr} required />
        <FieldError>{rErr && t(rErr)}</FieldError>
      </div>
      <div className="sm:max-w-xs"><SubmitButton pending={pending}>{isOwner ? t("cor.submitOwner") : t("cor.submitRequest")}</SubmitButton></div>
    </form>
  );
}

export function DecisionButtons({ correctionId }: { correctionId: string }) {
  const t = useT();
  const approve = useActionForm(decideCorrectionAction.bind(null, correctionId, true), initial);
  const reject = useActionForm(decideCorrectionAction.bind(null, correctionId, false), initial);
  const rejErr = reject.state.fieldErrors?.note;
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <form onSubmit={approve.onSubmit} className="space-y-2" noValidate>
        <FormMessages state={approve.state} />
        <Label htmlFor={`ap-${correctionId}`}>{t("cor.note")}</Label>
        <Input id={`ap-${correctionId}`} name="note" maxLength={300} />
        <Button type="submit" disabled={approve.pending || reject.pending}>{t("cor.approve")}</Button>
      </form>
      <form onSubmit={reject.onSubmit} className="space-y-2" noValidate>
        <FormMessages state={reject.state} />
        <Label htmlFor={`rj-${correctionId}`}>{t("cor.noteRequired")}</Label>
        <Input id={`rj-${correctionId}`} name="note" maxLength={300} aria-invalid={!!rejErr} required />
        <FieldError>{rejErr && t(rejErr)}</FieldError>
        <Button type="submit" variant="danger" disabled={approve.pending || reject.pending}>{t("cor.reject")}</Button>
      </form>
    </div>
  );
}

export function CancelRequestButton({ correctionId }: { correctionId: string }) {
  const t = useT();
  const { state, onSubmit, pending } = useActionForm(cancelCorrectionAction.bind(null, correctionId), initial);
  return (
    <form onSubmit={onSubmit} className="space-y-1">
      {state.error && <p role="alert" className="text-sm text-danger">{t(state.error as MessageKey)}</p>}
      <Button type="submit" variant="ghost" disabled={pending}>{t("cor.cancel")}</Button>
    </form>
  );
}
