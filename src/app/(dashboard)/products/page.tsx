import type { Metadata } from "next";
import Link from "next/link";
import { Download, FolderTree, Package, PackagePlus, Upload } from "lucide-react";
import { Button, ButtonLink } from "@/components/ui/button";
import { Badge, EmptyState } from "@/components/ui/feedback";
import { Card } from "@/components/ui/card";
import { Input, Select } from "@/components/ui/input";
import { getTranslator } from "@/i18n/server";
import { listCategories, listProducts, PAGE_SIZE, type ProductSort, type StatusFilter } from "@/server/repositories/catalog";
import { getSessionContext } from "@/server/services/session";
import { sizeLabel } from "@/lib/formatting/units";
import { can } from "@/server/permissions";

export const metadata: Metadata = { title: "Products" };

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
const SORTS: ProductSort[] = ["name", "code", "updated"];
const STATUSES: StatusFilter[] = ["active", "archived", "all"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function ProductsPage({ searchParams }: PageProps<"/products">) {
  const { t } = await getTranslator();
  const sp = await searchParams;
  const ctx = await getSessionContext();
  const canEdit = can(ctx.membership?.role, "catalog.write");

  const q = first(sp.q)?.slice(0, 60) ?? "";
  const rawCategory = first(sp.category) ?? "";
  const categoryId = UUID.test(rawCategory) ? rawCategory : "";
  const sort = SORTS.find((s) => s === first(sp.sort)) ?? "name";
  const status = STATUSES.find((s) => s === first(sp.status)) ?? "active";
  const page = Math.max(1, Number(first(sp.page)) || 1);

  const [categories, { rows, total, error }] = await Promise.all([
    listCategories(),
    listProducts({ q, categoryId: categoryId || undefined, sort, status, page }),
  ]);
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const filtered = !!(q || categoryId || status !== "active");

  const href = (p: number) => {
    const u = new URLSearchParams();
    if (q) u.set("q", q);
    if (categoryId) u.set("category", categoryId);
    if (sort !== "name") u.set("sort", sort);
    if (status !== "active") u.set("status", status);
    if (p > 1) u.set("page", String(p));
    const s = u.toString();
    return s ? `/products?${s}` : "/products";
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-[28px] font-semibold tracking-tight">{t("cat.products.title")}</h1>
        <div className="flex flex-wrap gap-2">
          <ButtonLink href="/api/exports/products" variant="secondary" prefetch={false}>
            <Download className="size-4" aria-hidden />{t("cat.products.export")}
          </ButtonLink>
          {canEdit && (
            <>
              <ButtonLink href="/products/categories" variant="secondary"><FolderTree className="size-4" aria-hidden />{t("cat.products.categories")}</ButtonLink>
              <ButtonLink href="/products/import" variant="secondary"><Upload className="size-4" aria-hidden />{t("cat.products.import")}</ButtonLink>
              <ButtonLink href="/products/new"><PackagePlus className="size-4" aria-hidden />{t("cat.products.new")}</ButtonLink>
            </>
          )}
        </div>
      </div>

      {/* Plain GET form: filters live in the URL (shareable, back-button friendly, works without JS) */}
      <Card>
        <form method="get" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-[2fr_1fr_1fr_1fr_auto] lg:items-end">
          <div>
            <label htmlFor="q" className="sr-only">{t("common.search")}</label>
            <Input id="q" name="q" type="search" defaultValue={q} placeholder={t("cat.products.searchPlaceholder")} />
          </div>
          <div>
            <label htmlFor="category" className="sr-only">{t("cat.products.category")}</label>
            <Select id="category" name="category" defaultValue={categoryId}>
              <option value="">{t("cat.products.category")}: {t("common.all")}</option>
              {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </Select>
          </div>
          <div>
            <label htmlFor="sort" className="sr-only">{t("cat.products.sort")}</label>
            <Select id="sort" name="sort" defaultValue={sort}>
              {SORTS.map((s) => <option key={s} value={s}>{t("cat.products.sort")}: {t(`cat.products.sort.${s}`)}</option>)}
            </Select>
          </div>
          <div>
            <label htmlFor="status" className="sr-only">{t("cat.products.status")}</label>
            <Select id="status" name="status" defaultValue={status}>
              {STATUSES.map((s) => <option key={s} value={s}>{s === "all" ? t("common.all") : t(`cat.products.${s}`)}</option>)}
            </Select>
          </div>
          <Button type="submit">{t("cat.products.apply")}</Button>
        </form>
      </Card>

      {error ? (
        <EmptyState title={t("error.title")} body={t("error.body")} />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={<Package className="size-6" aria-hidden />}
          title={filtered ? t("cat.products.noMatch") : t("cat.products.emptyTitle")}
          body={filtered ? undefined : t("cat.products.emptyBody")}
          action={!filtered && canEdit ? <ButtonLink href="/products/new">{t("cat.products.new")}</ButtonLink> : undefined}
        />
      ) : (
        <>
          <p className="text-sm text-muted" aria-live="polite">{t("common.results", { count: total })}</p>
          <ul className="grid gap-3">
            {rows.map((p) => {
              const active = p.product_variants.filter((v) => v.is_active);
              return (
                <li key={p.id}>
                  <Link href={`/products/${p.id}`} className="block rounded-[var(--radius-card)] border border-border bg-surface p-4 shadow-soft transition-colors duration-150 hover:bg-surface-soft sm:p-5">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="truncate text-lg font-semibold">{p.name}</p>
                        <p className="num text-sm text-muted">{p.product_code} · {p.categories?.name ?? t("cat.products.uncategorised")}</p>
                      </div>
                      <Badge tone={p.is_active ? "success" : "neutral"}>{p.is_active ? t("cat.products.active") : t("cat.products.archived")}</Badge>
                    </div>
                    <p className="mt-2 flex flex-wrap gap-1.5 text-sm">
                      <span className="text-muted">{t("cat.products.variants", { count: active.length })}:</span>
                      {active.slice(0, 6).map((v) => (
                        <span key={v.id} className="num rounded-md bg-surface-soft px-1.5 py-0.5">{sizeLabel(v.size_value, v.size_unit) || v.sku}</span>
                      ))}
                      {active.length > 6 && <span className="text-muted">+{active.length - 6}</span>}
                    </p>
                  </Link>
                </li>
              );
            })}
          </ul>

          {pages > 1 && (
            <nav aria-label="Pagination" className="flex items-center justify-between gap-3">
              {page > 1 ? <ButtonLink href={href(page - 1)} variant="secondary">{t("common.previous")}</ButtonLink> : <span />}
              <span className="num text-sm text-muted">{t("common.pageOf", { page, pages })}</span>
              {page < pages ? <ButtonLink href={href(page + 1)} variant="secondary">{t("common.next")}</ButtonLink> : <span />}
            </nav>
          )}
        </>
      )}
    </div>
  );
}
