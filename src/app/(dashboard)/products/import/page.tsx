import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { ImportForm } from "@/components/products/catalog-forms";
import { Card } from "@/components/ui/card";
import { getTranslator } from "@/i18n/server";
import { IMPORT_COLUMNS } from "@/features/products/import";
import { getSessionContext } from "@/server/services/session";
import { can } from "@/server/permissions";

export const metadata: Metadata = { title: "Import products" };

export default async function ImportPage() {
  const { t } = await getTranslator();
  const ctx = await getSessionContext();
  if (!can(ctx.membership?.role, "catalog.write")) redirect("/products");
  return (
    <div className="max-w-3xl space-y-6">
      <div>
        <h1 className="text-[28px] font-semibold tracking-tight">{t("cat.import.title")}</h1>
        <p className="mt-1 text-muted">{t("cat.import.body")}</p>
      </div>
      <Card className="space-y-4">
        <p className="num break-words text-sm text-muted">{IMPORT_COLUMNS.join(", ")}</p>
        <ImportForm />
      </Card>
    </div>
  );
}
