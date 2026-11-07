import type { Metadata } from "next";
import { InvitationButtons, InviteForm, RoleSelect, StatusButton } from "@/components/settings/team-controls";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/feedback";
import { getTranslator } from "@/i18n/server";
import type { MessageKey } from "@/i18n";
import { formatShopDateTime } from "@/lib/dates/format";
import { adminConfigured } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { can } from "@/server/permissions";
import { listTeam } from "@/server/repositories/settings";
import { getSessionContext } from "@/server/services/session";

export const metadata: Metadata = { title: "Team" };
const tone = { active: "success", invited: "info", suspended: "warning" } as const;

export default async function TeamPage() {
  const { t } = await getTranslator();
  const ctx = await getSessionContext();
  const m = ctx.membership!;
  const manage = can(m.role, "team.manage");
  const team = await listTeam(await createClient(), m.shopId);

  return (
    <div className="max-w-5xl space-y-6">
      <Card className="space-y-4 p-0">
        <div className="px-5 pt-5"><h2 className="text-xl font-semibold">{t("team.title")}</h2><p className="text-sm text-muted">{t("team.subtitle")}</p></div>
        <div tabIndex={0} className="overflow-x-auto">
          <table className="w-full min-w-[40rem] text-left text-sm">
            <thead className="border-y border-border text-muted">
              <tr>
                {(["team.col.person", "team.col.role", "team.col.status", "team.col.since"] as MessageKey[]).map((k) => <th key={k} scope="col" className="px-4 py-3 font-medium">{t(k)}</th>)}
                {manage && <th scope="col" className="px-4 py-3"><span className="sr-only">{t("common.actions")}</span></th>}
              </tr>
            </thead>
            <tbody>
              {team.map((p) => {
                const you = p.userId === ctx.user!.id;
                const label = p.name || p.email || "";
                return (
                  <tr key={p.id} className="border-t border-border align-top">
                    <td className="px-4 py-3"><span className="font-medium">{label}</span> {you && <span className="text-muted">{t("team.you")}</span>}<br /><span className="break-all text-muted">{p.email}</span></td>
                    <td className="px-4 py-3">
                      {manage && p.status !== "invited"
                        ? <RoleSelect membershipId={p.id} role={p.role} label={`${t("team.col.role")}: ${label}`} />
                        : <Badge tone="info">{t(`common.role.${p.role}` as MessageKey)}</Badge>}
                    </td>
                    <td className="px-4 py-3"><Badge tone={tone[p.status]}>{t(`team.status.${p.status}` as MessageKey)}</Badge></td>
                    <td className="num px-4 py-3 text-muted">{formatShopDateTime(p.createdAt, m.timezone)}</td>
                    {manage && (
                      <td className="px-4 py-3">
                        {p.status === "invited" ? <InvitationButtons membershipId={p.id} email={p.email} />
                          : p.status === "active" ? <StatusButton membershipId={p.id} to="suspended" name={label} />
                          : <StatusButton membershipId={p.id} to="active" name={label} />}
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="px-5 pb-5 text-xs text-muted">{t("team.limits")}</p>
      </Card>

      {manage && (
        <Card className="space-y-4">
          <h2 className="text-xl font-semibold">{t("team.invite")}</h2>
          <InviteForm serviceKeyReady={adminConfigured()} />
        </Card>
      )}
    </div>
  );
}
