import { cache } from "react";
import { isSupabaseConfigured } from "@/lib/supabase/env";
import { createClient } from "@/lib/supabase/server";

export type Role = "owner" | "stock_manager" | "viewer";

export interface SessionContext {
  user: { id: string; email: string | null } | null;
  displayName: string;
  membership: { shopId: string; shopName: string; timezone: string; role: Role } | null;
  /** Set when the user has a membership that is not active (so /setup does not offer to create a second shop). */
  inactive: "invited" | "suspended" | null;
}

/**
 * Resolves the authenticated user and their active shop membership.
 * Uses getUser() (validated with Supabase Auth). Deduplicated per request.
 * Data access is still protected by RLS; this is for routing and display.
 */
export const getSessionContext = cache(async (): Promise<SessionContext> => {
  const empty: SessionContext = { user: null, displayName: "", membership: null, inactive: null };
  if (!isSupabaseConfigured()) return empty;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return empty;

  const [{ data: m }, { data: profile }] = await Promise.all([
    supabase
      .from("shop_memberships")
      .select("role, shops(id, name, timezone)")
      .eq("user_id", user.id)
      .eq("status", "active")
      .limit(1)
      .maybeSingle(),
    supabase.from("user_profiles").select("display_name").eq("id", user.id).maybeSingle(),
  ]);

  const shop = Array.isArray(m?.shops) ? m?.shops[0] : m?.shops;
  let inactive: SessionContext["inactive"] = null;
  if (!(m && shop)) {
    const { data: other } = await supabase.from("shop_memberships").select("status").eq("user_id", user.id).neq("status", "active").limit(1).maybeSingle();
    inactive = (other?.status as SessionContext["inactive"]) ?? null;
  }
  return {
    user: { id: user.id, email: user.email ?? null },
    displayName: profile?.display_name || user.email?.split("@")[0] || "",
    membership:
      m && shop
        ? { shopId: shop.id, shopName: shop.name, timezone: shop.timezone, role: m.role as Role }
        : null,
    inactive,
  };
});
