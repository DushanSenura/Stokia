"use client";

import { Loader2 } from "lucide-react";
import { startTransition, useActionState, useEffect, useRef } from "react";
import { Alert } from "@/components/ui/feedback";
import { Button } from "@/components/ui/button";
import { FieldError, Input, Label } from "@/components/ui/input";
import type { FormState } from "@/server/actions/auth";
import { useT } from "@/providers/i18n-provider";
import type { MessageKey } from "@/i18n";

/**
 * Server-action form that does NOT auto-reset after submit.
 * React 19 clears uncontrolled fields after every `<form action>`, which would wipe what a
 * user typed when validation fails (and drop a chosen file between "check" and "import").
 * Submitting via onSubmit keeps values; `resetOnSuccess` clears them only after a real success.
 */
export function useActionForm<S extends FormState>(
  action: (prev: S, fd: FormData) => Promise<S>,
  initial: S,
  opts: { resetOnSuccess?: boolean } = {},
) {
  // S is a plain (non-promise) object, so Awaited<S> is S; the casts only satisfy React's overloads.
  const [rawState, dispatch, pending] = useActionState(action as unknown as (p: unknown, fd: FormData) => Promise<unknown>, initial as unknown);
  const state = rawState as S;
  const formRef = useRef<HTMLFormElement | null>(null);

  useEffect(() => {
    if (opts.resetOnSuccess && state.success) formRef.current?.reset();
  }, [state, opts.resetOnSuccess]);

  const onSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    formRef.current = e.currentTarget;
    const fd = new FormData(e.currentTarget, (e.nativeEvent as SubmitEvent).submitter);
    startTransition(() => dispatch(fd));
  };
  return { state, onSubmit, pending };
}

export function SubmitButton({ children, pending }: { children: React.ReactNode; pending?: boolean }) {
  return (
    <Button type="submit" size="lg" className="w-full" disabled={pending} aria-busy={pending}>
      {pending && <Loader2 className="size-4 animate-spin" aria-hidden />}
      {children}
    </Button>
  );
}

export function Field({
  name,
  label,
  state,
  ...props
}: { name: string; label: MessageKey; state: FormState } & React.InputHTMLAttributes<HTMLInputElement>) {
  const t = useT();
  const err = state.fieldErrors?.[name];
  return (
    <div>
      <Label htmlFor={name}>{t(label)}</Label>
      <Input id={name} name={name} aria-invalid={!!err} aria-describedby={err ? `${name}-err` : undefined} {...props} />
      <FieldError id={`${name}-err`}>{err && t(err)}</FieldError>
    </div>
  );
}

export function FormMessages({ state }: { state: FormState }) {
  const t = useT();
  if (state.error) return <Alert tone="danger">{t(state.error)}</Alert>;
  if (state.success) return <Alert tone="success">{t(state.success)}</Alert>;
  return null;
}
