"use client";

import { AlertTriangle, CheckCircle2, Download } from "lucide-react";
import { useState } from "react";
import { useActionForm } from "@/components/shared/form-bits";
import { Button, ButtonLink } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Alert, Badge } from "@/components/ui/feedback";
import { FieldError, Label, Select } from "@/components/ui/input";
import { repairSalesAction, runHealthCheckAction, type HealthState } from "@/server/actions/data";
import { useI18n } from "@/providers/i18n-provider";
import type { MessageKey } from "@/i18n";

const initial: HealthState = {};
const RANGES = [30, 90, 180, 365] as const;

export function DataHealth({ initialReport }: { initialReport?: HealthState["report"] }) {
  const { t, locale } = useI18n();
  const [days, setDays] = useState<number>(90);
  const check = useActionForm(runHealthCheckAction, initial);
  const repair = useActionForm(repairSalesAction, initial);
  const busy = check.pending || repair.pending;
  // the most recent result, from whichever button produced it
  const report = repair.state.report ?? check.state.report ?? initialReport;
  const repaired = repair.state.report && repair.state.report === report ? repair.state.repaired : undefined;
  const fail = report?.checks.filter((c) => c.count > 0) ?? [];
  const err = check.state.error ?? repair.state.error;

  const range = (
    <div>
      <Label htmlFor="data-days">{t("data.health.range")}</Label>
      <Select id="data-days" name="days" value={days} onChange={(e) => setDays(Number(e.target.value))}>
        {RANGES.map((d) => <option key={d} value={d}>{t("data.health.days", { days: d })}</option>)}
      </Select>
      <FieldError>{(check.state.fieldErrors?.days ?? repair.state.fieldErrors?.days) && t((check.state.fieldErrors?.days ?? repair.state.fieldErrors?.days) as MessageKey)}</FieldError>
    </div>
  );

  return (
    <div className="space-y-6">
      <Card className="space-y-4">
        <h2 className="text-xl font-semibold">{t("data.health.title")}</h2>
        <p className="text-muted">{t("data.health.body")}</p>
        <form onSubmit={check.onSubmit} className="flex flex-wrap items-end gap-3" noValidate>
          {range}
          <Button type="submit" disabled={busy} aria-busy={check.pending}>{check.pending ? t("data.health.running") : t("data.health.run")}</Button>
        </form>
        {err && <Alert tone="danger">{t(err as MessageKey)}</Alert>}

        {report && (
          <div className="space-y-3" aria-live="polite">
            {repaired !== undefined && <Alert tone="success">{repaired > 0 ? t("data.repair.done", { count: repaired }) : t("data.repair.none")}</Alert>}
            {report.errors === 0 && report.warnings === 0 ? (
              <Alert tone="success"><span className="inline-flex items-center gap-2"><CheckCircle2 className="size-4" aria-hidden />{t("data.health.ok")}</span></Alert>
            ) : (
              <Alert tone={report.errors > 0 ? "danger" : "warning"}>
                <span className="inline-flex items-center gap-2"><AlertTriangle className="size-4" aria-hidden />
                  {report.errors > 0 ? t("data.health.found", { errors: report.errors, warnings: report.warnings }) : t("data.health.warningsOnly", { warnings: report.warnings })}
                </span>
              </Alert>
            )}
            {fail.length > 0 && (
              <ul className="divide-y divide-border rounded-xl border border-border">
                {fail.map((c) => (
                  <li key={c.key} className="space-y-1 p-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge tone={c.severity === "error" ? "danger" : "warning"}>{t(c.severity === "error" ? "data.health.error" : "data.health.warning")}</Badge>
                      <span>{t(`data.check.${c.key}` as MessageKey, { count: c.count })}</span>
                    </div>
                    {c.sample.length > 0 && <p className="num break-all text-xs text-muted">{t("data.health.sample")}: {c.sample.join(", ")}</p>}
                  </li>
                ))}
              </ul>
            )}
            <p className="text-xs text-muted">{t("data.health.checkedAt", { when: new Date(report.checked_at).toLocaleString(locale === "si" ? "si-LK" : "en-LK", { timeZone: "Asia/Colombo" }) })}</p>
          </div>
        )}
      </Card>

      <Card className="space-y-4">
        <h2 className="text-xl font-semibold">{t("data.repair.title")}</h2>
        <p className="text-muted">{t("data.repair.body")}</p>
        <form onSubmit={(e) => { if (!window.confirm(t("data.repair.confirm"))) { e.preventDefault(); return; } repair.onSubmit(e); }} className="flex flex-wrap items-end gap-3" noValidate>
          <input type="hidden" name="days" value={days} />
          <Button type="submit" variant={report && report.errors > 0 ? "primary" : "secondary"} disabled={busy} aria-busy={repair.pending}>{t("data.repair.run")}</Button>
        </form>
      </Card>

      <Card className="space-y-4">
        <h2 className="text-xl font-semibold">{t("data.backup.title")}</h2>
        <p className="text-muted">{t("data.backup.body")}</p>
        <ButtonLink href="/api/exports/backup" variant="secondary" prefetch={false} download><Download className="size-4" aria-hidden />{t("data.backup.download")}</ButtonLink>
        <p className="text-sm text-muted">{t("data.backup.note")}</p>
      </Card>
    </div>
  );
}
