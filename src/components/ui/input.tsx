import * as React from "react";
import { cn } from "@/lib/utils/cn";

export function Label({ className, ...props }: React.LabelHTMLAttributes<HTMLLabelElement>) {
  return <label className={cn("mb-1.5 block text-sm font-medium", className)} {...props} />;
}

export function Input({ className, ...props }: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={cn(
        "min-h-11 w-full rounded-xl border border-border bg-surface px-3.5 text-base text-foreground placeholder:text-muted/70 transition-shadow duration-150 focus:border-primary focus:outline-none focus:ring-2 focus:ring-ring/40 aria-[invalid=true]:border-danger",
        className,
      )}
      {...props}
    />
  );
}

/** Large numeric field for stock quantities (numeric keypad on phones). */
export function QuantityInput({ className, ...props }: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <Input
      type="text"
      inputMode="decimal"
      pattern="[0-9]*[.]?[0-9]*"
      className={cn("num h-14 text-center text-2xl font-semibold", className)}
      {...props}
    />
  );
}

const fieldBase =
  "min-h-11 w-full rounded-xl border border-border bg-surface px-3.5 text-base text-foreground transition-shadow duration-150 focus:border-primary focus:outline-none focus:ring-2 focus:ring-ring/40 aria-[invalid=true]:border-danger";

export function Select({ className, ...props }: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return <select className={cn(fieldBase, className)} {...props} />;
}

export function Textarea({ className, ...props }: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={cn(fieldBase, "py-2.5", className)} {...props} />;
}

export function FieldError({ id, children }: { id?: string; children?: React.ReactNode }) {
  if (!children) return null;
  return (
    <p id={id} role="alert" className="mt-1.5 text-sm text-danger">
      {children}
    </p>
  );
}
