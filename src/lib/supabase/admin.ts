import "server-only";
import { createClient } from "@supabase/supabase-js";

/**
 * Service-role client: bypasses Row Level Security. SERVER ONLY (the `server-only` import makes bundling it into browser code a build error).
 * Used for exactly one thing: inviting people (creating their auth account). Every shop-data write still goes through the signed-in
 * user's own client, so RLS and role checks apply.
 */
export function createAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
}

export const adminConfigured = () => !!process.env.SUPABASE_SERVICE_ROLE_KEY && !!process.env.NEXT_PUBLIC_SUPABASE_URL;
