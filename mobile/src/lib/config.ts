/**
 * Build-time configuration. Expo inlines `EXPO_PUBLIC_*` values into the app when it is bundled, so they are PUBLIC: this app
 * must never be given a service-role key or any other secret.
 */
export const config = {
  apiUrl: process.env.EXPO_PUBLIC_API_URL ?? "",
  supabaseUrl: process.env.EXPO_PUBLIC_SUPABASE_URL ?? "",
  supabaseAnonKey: process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? "",
  siteUrl: process.env.EXPO_PUBLIC_SITE_URL ?? "",
};

export const isConfigured = Boolean(config.apiUrl && config.supabaseUrl && config.supabaseAnonKey);
