"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { createAdminClient } from "@/lib/supabase/admin";
import { rolesFor } from "@/server/permissions";
import { requireRole } from "@/server/services/guard";
import { inviteSchema, roleSchema, statusSchema } from "@/server/validators/settings";
import type { FormState } from "@/server/actions/auth";
import type { MessageKey } from "@/i18n";

async function origin() {
  if (process.env.NEXT_PUBLIC_SITE_URL) return process.env.NEXT_PUBLIC_SITE_URL.replace(/\/$/, "");
  const h = await headers();
  return `${h.get("x-forwarded-proto") ?? "http"}://${h.get("x-forwarded-host") ?? h.get("host")}`;
}

function mapError(err: { message?: string; code?: string } | null): MessageKey {
  const text = err?.message ?? "";
  if (/LAST_OWNER/.test(text)) return "team.err.lastOwner";
  if (/FORBIDDEN|row-level security/.test(text)) return "error.forbidden";
  if (err?.code === "23505") return "team.err.alreadyMember";
  return "auth.error.generic";
}

/**
 * Invite someone to the shop. Accounts are invitation-only: the owner names the person and their role, Supabase emails them a
 * link to set a password, and their membership becomes active the first time they sign in. Needs SUPABASE_SERVICE_ROLE_KEY
 * (server only) because creating an auth account is an admin operation.
 */
export async function inviteMemberAction(_: FormState, fd: FormData): Promise<FormState> {
  const g = await requireRole(rolesFor("team.manage"));
  if (!g.ok) return { error: g.error };
  const p = inviteSchema.safeParse(Object.fromEntries(fd));
  if (!p.success) {
    const fieldErrors: Record<string, MessageKey> = {};
    for (const i of p.error.issues) fieldErrors[String(i.path[0])] ??= i.message as MessageKey;
    return { fieldErrors };
  }
  const { email, display_name, role, password } = p.data;

  const admin = createAdminClient();
  if (!admin) return { error: "team.err.noServiceKey" };

  // Is there already an account for this email, and is it already in a shop? (One shop per account in this version.)
  const { data: existingId } = await admin.rpc("find_user_by_email", { p_email: email });
  let userId = (existingId as string | null) ?? null;
  if (userId) {
    const { data: memberships } = await admin.from("shop_memberships").select("shop_id,status").eq("user_id", userId);
    if ((memberships ?? []).some((m) => m.shop_id === g.shopId)) return { error: "team.err.alreadyMember" };
    if ((memberships ?? []).length > 0) return { error: "team.err.otherShop" };
  } else if (password) {
    // The owner chose the password: create the account ready to sign in (no email link). The password is never stored or logged here.
    const { data, error } = await admin.auth.admin.createUser({
      email, password, email_confirm: true, user_metadata: display_name ? { display_name } : undefined,
    });
    if (error || !data.user) return { error: error?.status === 422 ? "auth.error.passwordShort" : "team.err.inviteFailed" };
    userId = data.user.id;
  } else {
    const { data, error } = await admin.auth.admin.inviteUserByEmail(email, {
      data: display_name ? { display_name } : undefined,
      redirectTo: `${await origin()}/auth/callback?next=/update-password`,
    });
    if (error || !data.user) return { error: error?.status === 429 ? "auth.error.rateLimit" : "team.err.inviteFailed" };
    userId = data.user.id;
  }

  // The membership is written as the signed-in owner, so Row Level Security (owners only) still applies.
  const { error } = await g.supabase.from("shop_memberships").insert({ shop_id: g.shopId, user_id: userId, role, status: "invited" });
  if (error) return { error: mapError(error) };
  revalidatePath("/settings/team");
  return { success: existingId ? "team.invitedExisting" : password ? "team.createdWithPassword" : "team.invited" };
}

/** Send the invitation email again (for someone who has not accepted yet). */
export async function resendInviteAction(email: string, _: FormState): Promise<FormState> {
  const g = await requireRole(rolesFor("team.manage"));
  if (!g.ok) return { error: g.error };
  const admin = createAdminClient();
  if (!admin) return { error: "team.err.noServiceKey" };
  const { error } = await admin.auth.admin.inviteUserByEmail(email, { redirectTo: `${await origin()}/auth/callback?next=/update-password` });
  if (error) return { error: error.status === 429 ? "auth.error.rateLimit" : "team.err.inviteFailed" };
  return { success: "team.resent" };
}

export async function changeRoleAction(membershipId: string, _: FormState, fd: FormData): Promise<FormState> {
  const g = await requireRole(rolesFor("team.manage"));
  if (!g.ok) return { error: g.error };
  const role = roleSchema.safeParse(fd.get("role"));
  if (!role.success) return { error: "team.err.role" };
  const { data, error } = await g.supabase.from("shop_memberships").update({ role: role.data }).eq("id", membershipId).eq("shop_id", g.shopId).select("id");
  if (error) return { error: mapError(error) };
  if (!data?.length) return { error: "error.forbidden" };
  revalidatePath("/settings/team");
  return { success: "common.saved" };
}

export async function setMemberStatusAction(membershipId: string, status: "active" | "suspended", _: FormState): Promise<FormState> {
  const g = await requireRole(rolesFor("team.manage"));
  if (!g.ok) return { error: g.error };
  if (!statusSchema.safeParse(status).success) return { error: "auth.error.generic" };
  const { data, error } = await g.supabase.from("shop_memberships").update({ status }).eq("id", membershipId).eq("shop_id", g.shopId).select("id");
  if (error) return { error: mapError(error) };
  if (!data?.length) return { error: "error.forbidden" };
  revalidatePath("/settings/team");
  return { success: status === "suspended" ? "team.suspended" : "team.reactivated" };
}

/** Cancel an invitation that has not been accepted. (Accepted members are suspended, never deleted, so history keeps its author.) */
export async function cancelInvitationAction(membershipId: string, _: FormState): Promise<FormState> {
  const g = await requireRole(rolesFor("team.manage"));
  if (!g.ok) return { error: g.error };
  const { data, error } = await g.supabase.from("shop_memberships").delete().eq("id", membershipId).eq("shop_id", g.shopId).eq("status", "invited").select("id");
  if (error) return { error: mapError(error) };
  if (!data?.length) return { error: "team.err.notInvited" };
  revalidatePath("/settings/team");
  return { success: "team.invitationCancelled" };
}
