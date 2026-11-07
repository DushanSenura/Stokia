"use server";

import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { LOCALE_COOKIE } from "@/i18n";
import { createClient } from "@/lib/supabase/server";
import { rolesFor } from "@/server/permissions";
import { requireRole } from "@/server/services/guard";
import { getSessionContext } from "@/server/services/session";
import { passwordSchema, profileSchema, shopSettingsSchema } from "@/server/validators/settings";
import type { FormState } from "@/server/actions/auth";
import type { MessageKey } from "@/i18n";

function fieldErrors(issues: { path: PropertyKey[]; message: string }[]): FormState {
  const out: Record<string, MessageKey> = {};
  for (const i of issues) out[String(i.path[0] ?? "form")] ??= i.message as MessageKey;
  return { fieldErrors: out };
}

/** Shop name, timezone and valuation policy. Owners only (RLS + the database trigger enforce it as well). */
export async function updateShopAction(_: FormState, fd: FormData): Promise<FormState> {
  const g = await requireRole(rolesFor("settings.write"));
  if (!g.ok) return { error: g.error };
  const p = shopSettingsSchema.safeParse(Object.fromEntries(fd));
  if (!p.success) return fieldErrors(p.error.issues);

  const { data, error } = await g.supabase.from("shops")
    .update({ name: p.data.name, timezone: p.data.timezone, settings: { valuation_policy: p.data.valuation_policy } })
    .eq("id", g.shopId).select("id");
  if (error) {
    const t = error.message ?? "";
    if (/TIMEZONE_LOCKED/.test(t)) return { fieldErrors: { timezone: "set.err.timezoneLocked" } };
    if (/INVALID_TIMEZONE/.test(t)) return { fieldErrors: { timezone: "set.err.timezone" } };
    if (/INVALID_NAME/.test(t)) return { fieldErrors: { name: "setup.error.name" } };
    if (/INVALID_SETTING/.test(t)) return { fieldErrors: { valuation_policy: "set.err.policy" } };
    return { error: "auth.error.generic" };
  }
  if (!data?.length) return { error: "error.forbidden" };
  for (const path of ["/settings/shop", "/dashboard", "/reports", "/analytics"]) revalidatePath(path);
  revalidatePath("/", "layout");
  return { success: "common.saved" };
}

/** Own profile only: display name and preferred language (the column grants make anything else impossible). */
export async function updateProfileAction(_: FormState, fd: FormData): Promise<FormState> {
  const ctx = await getSessionContext();
  if (!ctx.user) return { error: "auth.error.notSignedIn" };
  const p = profileSchema.safeParse(Object.fromEntries(fd));
  if (!p.success) return fieldErrors(p.error.issues);

  const supabase = await createClient();
  const { error } = await supabase.from("user_profiles").update(p.data).eq("id", ctx.user.id);
  if (error) return { error: "auth.error.generic" };
  (await cookies()).set(LOCALE_COOKIE, p.data.preferred_language, { path: "/", maxAge: 60 * 60 * 24 * 365, sameSite: "lax" });
  revalidatePath("/", "layout");
  return { success: "common.saved" };
}

export async function changePasswordAction(_: FormState, fd: FormData): Promise<FormState> {
  const ctx = await getSessionContext();
  if (!ctx.user) return { error: "auth.error.notSignedIn" };
  const p = passwordSchema.safeParse(Object.fromEntries(fd));
  if (!p.success) return fieldErrors(p.error.issues);
  const { error } = await (await createClient()).auth.updateUser({ password: p.data.password });
  if (error) return { error: error.status === 429 ? "auth.error.rateLimit" : "auth.error.generic" };
  return { success: "prof.passwordChanged" };
}

/** Ends every session except this one (a lost phone, a shared computer). */
export async function signOutOtherDevicesAction(_: FormState): Promise<FormState> {
  const ctx = await getSessionContext();
  if (!ctx.user) return { error: "auth.error.notSignedIn" };
  const { error } = await (await createClient()).auth.signOut({ scope: "others" });
  if (error) return { error: "auth.error.generic" };
  return { success: "prof.signedOutOthers" };
}
