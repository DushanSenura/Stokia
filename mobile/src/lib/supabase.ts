import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { config } from "./config";
import { secureStorage } from "./secure-storage";

let client: SupabaseClient | null = null;

/**
 * Supabase is used for ONE thing in the phone app: signing in and keeping the session fresh. Every shop-data read and write goes
 * through the Stokia server API (which checks the same session token), never straight to the database from the phone.
 * The session is kept in the platform's secure store.
 */
export function getSupabase(): SupabaseClient {
  client ??= createClient(config.supabaseUrl, config.supabaseAnonKey, {
    auth: { storage: secureStorage, autoRefreshToken: true, persistSession: true, detectSessionInUrl: false },
  });
  return client;
}
