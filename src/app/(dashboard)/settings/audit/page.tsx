import type { Metadata } from "next";
import Link from "next/link";
import { Download } from "lucide-react";
import { Button, ButtonLink } from "@/components/ui/button";
import { Alert, Badge, EmptyState } from "@/components/ui/feedback";
import { Card } from "@/components/ui/card";
import { Input, Label, Select } from "@/components/ui/input";
import { changedFields, KNOWN_ACTIONS, KNOWN_ENTITIES, maskedJson } from "@/features/settings/audit";
import { getTranslator } from "@/i18n/server";
import type { MessageKey } from "@/i18n";
import { addDays, dayStartInstant, isBusinessDate } from "@/lib/dates/business";
import { formatShopDateTime } from "@/lib/dates/format";
import { createClient } from "@/lib/supabase/server";
import { can } from "@/server/permissions";
import { AUDIT_PAGE_SIZE, auditFacets, listAudit, listTeam } from "@/server/repositories/settings";
import { getSessionContext } from "@/server/services/session";

export const metadata: Metadata = { title: "Audit log" };
const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const linkCls = "text-action underline-offset-4 hover:underline dark:text-sage";

function entityHref(type: string, id: string | null): string | null {
  if (!id) return null;
  if (type === "stock_count_sessions") return `/stock-history/${id}`;
  if (type === "products") return `/products/${id}`;
  return null;
}

export default async function AuditPage({ searchParams }: PageProps<"/settings/audit">) {
  const { t } = await getTranslator();
  const m = (await getSessionContext()).membership!;
  if (!can(m.role, "audit.read")) return <Alert tone="info">{t("audit.ownerOnly")}</Alert>;

  const sp = await searchParams;
  const from = isBusinessDate(first(sp.from)) ? first(sp.from) : undefined;
  const to = isBusinessDate(first(sp.to)) ? first(sp.to) : undefined;
  const action = first(sp.action)?.slice(0, 60) || undefined;
  const entity = first(sp.entity)?.slice(0, 60) || undefined;
  const user = UUID.test(first(sp.user) ?? "") ? first(sp.user) : undefined;
  const page = Math.max(1, Number(first(sp.page)) || 1);

  const supabase = await createClient();
  const [{ rows, total, error }, facets, team] = await Promise.all([
    listAudit(supabase, m.shopId, {
      page, action, entity, user,
      from: from ? dayStartInstant(from, m.timezone) : undefined, to: to ? dayStartInstant(addDays(to, 1), m.timezone) : undefined,
    }),
    auditFacets(supabase, m.shopId), listTeam(supabase, m.shopId),
  ]);
  const pages = Math.max(1, Math.ceil(total / AUDIT_PAGE_SIZE));
  const qs = (p: number) => {
    const u = new URLSearchParams({ ...(from ? { from } : {}), ...(to ? { to } : {}), ...(action ? { action } : {}), ...(entity ? { entity } : {}), ...(user ? { user } : {}), ...(p > 1 ? { page: String(p) } : {}) });
    return u.toString() ? `?${u}` : "";
  };
  const actionLabel = (a: string) => ((KNOWN_ACTIONS as readonly string[]).includes(a) ? t(`audit.action.${a}` as MessageKey) : a);
  const entityLabel = (e: string) => ((KNOWN_ENTITIES as readonly string[]).includes(e) ? t(`audit.entity.${e}` as MessageKey) : e);
  const actions = [...new Set([...KNOWN_ACTIONS, ...facets.actions])];
  const entities = [...new Set([...KNOWN_ENTITIES, ...facets.entities])];

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <p className="max-w-2xl text-muted">{t("audit.subtitle")}</p>
        <ButtonLink href={`/api/exports/audit${qs(1)}`} variant="secondary" prefetch={false}><Download className="size-4" aria-hidden />{t("audit.export")}</ButtonLink>
      </div>

      <Card>
        <form method="get" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-[repeat(5,minmax(0,1fr))_auto] lg:items-end">
          <div><Label htmlFor="from">{t("sh.from")}</Label><Input id="from" name="from" type="date" defaultValue={from} /></div>
          <div><Label htmlFor="to">{t("sh.to")}</Label><Input id="to" name="to" type="date" defaultValue={to} /></div>
          <div>
            <Label htmlFor="user">{t("audit.col.who")}</Label>
            <Select id="user" name="user" defaultValue={user ?? ""}><option value="">{t("audit.filter.all")}</option>{team.map((p) => <option key={p.userId} value={p.userId}>{p.name || p.email}</option>)}</Select>
          </div>
          <div>
            <Label htmlFor="action">{t("audit.filter.action")}</Label>
            <Select id="action" name="action" defaultValue={action ?? ""}><option value="">{t("audit.filter.all")}</option>{actions.map((a) => <option key={a} value={a}>{actionLabel(a)}</option>)}</Select>
          </div>
          <div>
            <Label htmlFor="entity">{t("audit.filter.entity")}</Label>
            <Select id="entity" name="entity" defaultValue={entity ?? ""}><option value="">{t("audit.filter.all")}</option>{entities.map((e) => <option key={e} value={e}>{entityLabel(e)}</option>)}</Select>
          </div>
          <Button type="submit">{t("sh.filter")}</Button>
        </form>
      </Card>

      {error ? <EmptyState title={t("error.title")} body={t("error.body")} /> : rows.length === 0 ? <EmptyState title={t("audit.none")} /> : (
        <>
          <p className="text-sm text-muted" aria-live="polite">{t("common.results", { count: total })}</p>
          <div tabIndex={0} className="overflow-x-auto rounded-[var(--radius-card)] border border-border bg-surface shadow-soft">
            <table className="w-full min-w-[56rem] text-left text-sm">
              <thead className="border-b border-border text-muted">
                <tr>{(["audit.col.when", "audit.col.who", "audit.col.what", "audit.col.about", "audit.col.changes"] as MessageKey[]).map((k) => <th key={k} scope="col" className="px-4 py-3 font-medium">{t(k)}</th>)}</tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const changes = changedFields(r.before, r.after);
                  const href = entityHref(r.entityType, r.entityId);
                  return (
                    <tr key={r.id} className="border-t border-border align-top">
                      <td className="num whitespace-nowrap px-4 py-3">{formatShopDateTime(r.createdAt, m.timezone)}</td>
                      <td className="px-4 py-3">{r.user || <span className="text-muted">{t("audit.system")}</span>}</td>
                      <td className="px-4 py-3"><Badge tone={r.action.includes("reject") ? "danger" : r.action.includes("correction") || r.action === "delete" ? "warning" : "neutral"}>{actionLabel(r.action)}</Badge></td>
                      <td className="px-4 py-3">{href ? <Link href={href} className={linkCls}>{entityLabel(r.entityType)}</Link> : entityLabel(r.entityType)}</td>
                      <td className="px-4 py-3">
                        {changes.length > 0 && (
                          <ul className="num space-y-0.5 text-xs">
                            {changes.slice(0, 3).map((c) => <li key={c.field}><span className="text-muted">{c.field}:</span> {c.before !== "—" && <>{c.before} → </>}{c.after}</li>)}
                            {changes.length > 3 && <li className="text-muted">+{changes.length - 3}</li>}
                          </ul>
                        )}
                        <details className="mt-1">
                          <summary className={`flex min-h-11 cursor-pointer items-center text-xs ${linkCls}`}>{t("audit.details")}</summary>
                          <div className="grid gap-2 sm:grid-cols-2">
                            <div><p className="text-xs font-medium text-muted">{t("audit.before")}</p><pre className="max-h-60 overflow-auto rounded-lg bg-surface-soft p-2 text-xs">{maskedJson(r.before)}</pre></div>
                            <div><p className="text-xs font-medium text-muted">{t("audit.after")}</p><pre className="max-h-60 overflow-auto rounded-lg bg-surface-soft p-2 text-xs">{maskedJson(r.after)}</pre></div>
                          </div>
                        </details>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {pages > 1 && (
            <nav aria-label="Pagination" className="flex items-center justify-between gap-3">
              {page > 1 ? <ButtonLink href={`/settings/audit${qs(page - 1)}`} variant="secondary">{t("common.previous")}</ButtonLink> : <span />}
              <span className="num text-sm text-muted">{t("common.pageOf", { page, pages })}</span>
              {page < pages ? <ButtonLink href={`/settings/audit${qs(page + 1)}`} variant="secondary">{t("common.next")}</ButtonLink> : <span />}
            </nav>
          )}
        </>
      )}
    </div>
  );
}
