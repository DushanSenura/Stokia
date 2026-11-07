import type { Metadata } from "next";
import Link from "next/link";
import { Boxes } from "lucide-react";
import { Button, ButtonLink } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/feedback";
import { Input } from "@/components/ui/input";
import { getTranslator } from "@/i18n/server";
import { describeUnit } from "@/lib/calculations/packaging";
import { sizeLabel } from "@/lib/formatting/units";
import { PAGE_SIZE } from "@/server/repositories/catalog";
import { listVariantsForPackaging, toPackUnit } from "@/server/repositories/packaging";
import { getSessionContext } from "@/server/services/session";
import { can } from "@/server/permissions";

export const metadata: Metadata = { title: "Packaging" };
const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

export default async function PackagingPage({ searchParams }: PageProps<"/packaging">) {
  const { t } = await getTranslator();
  const sp = await searchParams;
  const ctx = await getSessionContext();
  const canEdit = can(ctx.membership?.role, "catalog.write");
  const q = first(sp.q)?.slice(0, 60) ?? "";
  const page = Math.max(1, Number(first(sp.page)) || 1);
  const { rows, total, error } = await listVariantsForPackaging({ q, page });
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const href = (p: number) => `/packaging?${new URLSearchParams({ ...(q ? { q } : {}), ...(p > 1 ? { page: String(p) } : {}) })}`;

  return (
    <div className="space-y-6">
      <div className="max-w-2xl">
        <h1 className="text-[28px] font-semibold tracking-tight">{t("pk.title")}</h1>
        <p className="mt-1 text-muted">{t("pk.subtitle")}</p>
      </div>

      <Card>
        <form method="get" className="flex flex-col gap-3 sm:flex-row">
          <label htmlFor="q" className="sr-only">{t("common.search")}</label>
          <Input id="q" name="q" type="search" defaultValue={q} placeholder={t("pk.searchPlaceholder")} />
          <Button type="submit">{t("common.search")}</Button>
        </form>
      </Card>

      {error ? (
        <EmptyState title={t("error.title")} body={t("error.body")} />
      ) : rows.length === 0 ? (
        <EmptyState icon={<Boxes className="size-6" aria-hidden />} title={q ? t("cat.products.noMatch") : t("pk.empty")} />
      ) : (
        <ul className="grid gap-3">
          {rows.map((v) => {
            const active = v.packaging_units.filter((u) => u.is_active).map(toPackUnit);
            return (
              <li key={v.id}>
                <Link href={`/packaging/${v.id}`} className="block rounded-[var(--radius-card)] border border-border bg-surface p-4 shadow-soft transition-colors duration-150 hover:bg-surface-soft sm:p-5">
                  <p className="text-lg font-semibold">{v.products?.name} <span className="font-normal text-muted">{sizeLabel(v.size_value, v.size_unit)}</span></p>
                  <p className="num text-sm text-muted">{v.sku} · {t("pk.countedIn")} {v.base_inventory_unit}</p>
                  <ul className="num mt-2 space-y-0.5 text-sm">
                    {active.length === 0
                      ? <li className="text-muted">{t("pk.none", { unit: v.base_inventory_unit })}</li>
                      : active.map((u) => <li key={u.id}>{describeUnit(u, active, v.base_inventory_unit)}</li>)}
                  </ul>
                </Link>
              </li>
            );
          })}
        </ul>
      )}

      {pages > 1 && (
        <nav aria-label="Pagination" className="flex items-center justify-between gap-3">
          {page > 1 ? <ButtonLink href={href(page - 1)} variant="secondary">{t("common.previous")}</ButtonLink> : <span />}
          <span className="num text-sm text-muted">{t("common.pageOf", { page, pages })}</span>
          {page < pages ? <ButtonLink href={href(page + 1)} variant="secondary">{t("common.next")}</ButtonLink> : <span />}
        </nav>
      )}
      {!canEdit && <p className="text-sm text-muted">{t("cat.products.readOnly")}</p>}
    </div>
  );
}
