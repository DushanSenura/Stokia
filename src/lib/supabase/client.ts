"use client";

import { createBrowserClient } from "@supabase/ssr";
import { getSupabaseEnv } from "./env";

export function createClient() {
  const env = getSupabaseEnv();
  if (!env) throw new Error("SUPABASE_NOT_CONFIGURED");
  return createBrowserClient(env.url, env.key);
}
