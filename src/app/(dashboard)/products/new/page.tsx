import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { ProductForm } from "@/components/products/catalog-forms";
import { Card } from "@/components/ui/card";
import { getTranslator } from "@/i18n/server";
import { listCategories } from "@/server/repositories/catalog";
import { getSessionContext } from "@/server/services/session";
import { can } from "@/server/permissions";

export const metadata: Metadata = { title: "New product" };

export default async function NewProductPage() {
  const { t } = await getTranslator();
  const ctx = await getSessionContext();
  if (!can(ctx.membership?.role, "catalog.write")) redirect("/products");
  const categories = await listCategories();
  return (
    <div className="max-w-3xl space-y-6">
      <h1 className="text-[28px] font-semibold tracking-tight">{t("cat.products.new")}</h1>
      <Card><ProductForm categories={categories} /></Card>
    </div>
  );
}
