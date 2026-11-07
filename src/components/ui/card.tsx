import * as React from "react";
import { cn } from "@/lib/utils/cn";

export function Card({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("rounded-[var(--radius-card)] border border-border bg-surface p-5 shadow-soft", className)}
      {...props}
    />
  );
}

/** Metric / KPI card. `value` uses tabular numerals. */
export function MetricCard({
  label,
  value,
  hint,
  icon,
  className,
}: {
  label: string;
  value: React.ReactNode;
  hint?: React.ReactNode;
  icon?: React.ReactNode;
  className?: string;
}) {
  return (
    <Card className={cn("flex flex-col gap-2", className)}>
      <div className="flex items-center justify-between gap-2 text-sm text-muted">
        <span>{label}</span>
        {icon}
      </div>
      <div className="num text-3xl font-semibold tracking-tight">{value}</div>
      {hint && <div className="text-sm text-muted">{hint}</div>}
    </Card>
  );
}
