"use client";

import { Download, FileSpreadsheet, FileText, Printer } from "lucide-react";
import { useTransition } from "react";
import { Button, buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils/cn";
import { useT } from "@/providers/i18n-provider";
import { recordPrintAction } from "@/server/actions/reports";

/** Export / print controls. Hidden when printing. Exports download through the logged API route. */
export function ReportActions({ month }: { month: string }) {
  const t = useT();
  const [pending, start] = useTransition();
  const link = (fmt: "pdf" | "xlsx" | "csv") => `/api/reports/${month}/${fmt}`;
  const cls = cn(buttonVariants({ variant: "secondary" }));
  return (
    <div className="flex flex-wrap items-center gap-2 print:hidden">
      <a className={cls} href={link("pdf")} download><FileText className="size-4" aria-hidden />{t("rep.exportPdf")}</a>
      <a className={cls} href={link("xlsx")} download><FileSpreadsheet className="size-4" aria-hidden />{t("rep.exportExcel")}</a>
      <a className={cls} href={link("csv")} download><Download className="size-4" aria-hidden />{t("rep.exportCsv")}</a>
      <Button
        variant="secondary" disabled={pending}
        onClick={() => { window.print(); start(async () => { await recordPrintAction(month); }); }}
      >
        <Printer className="size-4" aria-hidden />{t("rep.print")}
      </Button>
    </div>
  );
}
