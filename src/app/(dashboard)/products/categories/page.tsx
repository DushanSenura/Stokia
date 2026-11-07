import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { CategoryForm } from "@/components/products/catalog-forms";
import { ButtonLink } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { getTranslator } from "@/i18n/server";
import { listCategories } from "@/server/repositories/catalog";
import { getSessionContext } from "@/server/services/session";
import { can } from "@/server/permissions";

export const metadata: Metadata = { title: "Categories" };

export default async function CategoriesPage() {
  const { t } = await getTranslator();
  const ctx = await getSessionContext();
  if (!can(ctx.membership?.role, "catalog.write")) redirect("/products");
  const categories = await listCategories();
  return (
    <div className="max-w-2xl space-y-6">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-[28px] font-semibold tracking-tight">{t("cat.categories.title")}</h1>
        <ButtonLink href="/products" variant="ghost">{t("cat.categories.back")}</ButtonLink>
      </div>
      <Card><CategoryForm /></Card>
      {categories.length === 0 ? (
        <p className="text-muted">{t("cat.categories.none")}</p>
      ) : (
        <ul className="space-y-3">
          {categories.map((c) => <li key={c.id}><Card className="p-4"><CategoryForm category={c} /></Card></li>)}
        </ul>
      )}
    </div>
  );
}
