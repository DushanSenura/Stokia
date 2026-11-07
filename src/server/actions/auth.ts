"use server";

import { cookies, headers } from "next/headers";
import { LOCALE_COOKIE } from "@/i18n";
import { redirect } from "next/navigation";
import { isSupabaseConfigured } from "@/lib/supabase/env";
import { createClient } from "@/lib/supabase/server";
import {
  createShopSchema,
  loginSchema,
  resetRequestSchema,
  safeNextPath,
  updatePasswordSchema,
} from "@/server/validators/auth";
import type { MessageKey } from "@/i18n";

export interface FormState {
  /** i18n key */
  error?: MessageKey;
  fieldErrors?: Record<string, MessageKey>;
  success?: MessageKey;
  /** Set by create actions so the client can navigate to the new record. */
  id?: string;
}

function fieldErrors(issues: { path: PropertyKey[]; message: string }[]): FormState {
  const out: Record<string, MessageKey> = {};
  for (const i of issues) out[String(i.path[0] ?? "form")] ??= i.message as MessageKey;
  return { fieldErrors: out };
}

async function siteOrigin() {
  if (process.env.NEXT_PUBLIC_SITE_URL) return process.env.NEXT_PUBLIC_SITE_URL.replace(/\/$/, "");
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host");
  const proto = h.get("x-forwarded-proto") ?? "http";
  return `${proto}://${host}`;
}

export async function signInAction(_: FormState, formData: FormData): Promise<FormState> {
  if (!isSupabaseConfigured()) return { error: "error.supabaseMissing" };
  const parsed = loginSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return fieldErrors(parsed.error.issues);

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword(parsed.data);
  if (error) {
    // Deliberately vague: do not reveal whether the account exists.
    return { error: error.status === 429 ? "auth.error.rateLimit" : "auth.error.invalid" };
  }
  // Carry the person's saved language to this device.
  const { data: { user } } = await supabase.auth.getUser();
  if (user) {
    const { data: prof } = await supabase.from("user_profiles").select("preferred_language").eq("id", user.id).maybeSingle();
    if (prof?.preferred_language) (await cookies()).set(LOCALE_COOKIE, prof.preferred_language, { path: "/", maxAge: 60 * 60 * 24 * 365, sameSite: "lax" });
  }
  redirect(safeNextPath(formData.get("next")));
}

export async function signOutAction() {
  if (isSupabaseConfigured()) {
    const supabase = await createClient();
    await supabase.auth.signOut();
  }
  redirect("/login");
}

export async function requestPasswordResetAction(_: FormState, formData: FormData): Promise<FormState> {
  if (!isSupabaseConfigured()) return { error: "error.supabaseMissing" };
  const parsed = resetRequestSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return fieldErrors(parsed.error.issues);

  const supabase = await createClient();
  const origin = await siteOrigin();
  const { error } = await supabase.auth.resetPasswordForEmail(parsed.data.email, {
    redirectTo: `${origin}/auth/callback?next=/update-password`,
  });
  if (error?.status === 429) return { error: "auth.error.rateLimit" };
  // Same message whether or not the account exists (no account enumeration).
  return { success: "auth.reset.sent" };
}

export async function updatePasswordAction(_: FormState, formData: FormData): Promise<FormState> {
  if (!isSupabaseConfigured()) return { error: "error.supabaseMissing" };
  const parsed = updatePasswordSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return fieldErrors(parsed.error.issues);

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "auth.error.notSignedIn" };

  const { error } = await supabase.auth.updateUser({ password: parsed.data.password });
  if (error) return { error: "auth.error.generic" };
  await supabase.rpc("accept_invitation"); // an invited person is activated as soon as they have set a password
  redirect("/dashboard");
}

export async function createShopAction(_: FormState, formData: FormData): Promise<FormState> {
  if (!isSupabaseConfigured()) return { error: "error.supabaseMissing" };
  const parsed = createShopSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return fieldErrors(parsed.error.issues);

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "auth.error.notSignedIn" };

  // Runs as a SECURITY DEFINER function: creates shop + owner membership atomically.
  const { error } = await supabase.rpc("create_shop", {
    p_name: parsed.data.name,
    p_timezone: parsed.data.timezone,
    p_currency: parsed.data.currency,
  });
  if (error) {
    if (error.message.includes("ALREADY_MEMBER")) return { error: "setup.error.exists" };
    return { error: "auth.error.generic" };
  }
  redirect("/dashboard");
}
