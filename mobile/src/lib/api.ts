import { createApi } from "./api-client";
import { config } from "./config";
import { getSupabase } from "./supabase";

/** The Stokia server API, authenticated with the signed-in session's access token. */
export const api = createApi({
  baseUrl: config.apiUrl,
  getToken: async () => (await getSupabase().auth.getSession()).data.session?.access_token ?? null,
  refresh: async () => (await getSupabase().auth.refreshSession()).data.session?.access_token ?? null,
});
