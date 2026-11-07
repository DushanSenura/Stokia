import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { getSupabaseEnv } from "./env";

const PROTECTED = [
  "/dashboard",
  "/morning-stock",
  "/products",
  "/packaging",
  "/movements",
  "/stock-history",
  "/analytics",
  "/reports",
  "/settings",
  "/setup",
  "/update-password",
];
const AUTH_ONLY_ANON = ["/login", "/reset-password"];

const matches = (path: string, list: string[]) =>
  list.some((p) => path === p || path.startsWith(`${p}/`));

/** Refreshes the Supabase session cookie and applies coarse route protection. */
export async function updateSession(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const env = getSupabaseEnv();
  let response = NextResponse.next({ request });

  if (!env) {
    // Not configured: protected pages cannot work. Send to login, which explains why.
    if (matches(pathname, PROTECTED)) {
      const url = new URL("/login", request.url);
      url.searchParams.set("next", pathname);
      return NextResponse.redirect(url);
    }
    return response;
  }

  const supabase = createServerClient(env.url, env.key, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll(list) {
        list.forEach(({ name, value }) => request.cookies.set(name, value));
        response = NextResponse.next({ request });
        list.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
      },
    },
  });

  // getUser() validates the JWT with Supabase Auth (unlike getSession()).
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user && matches(pathname, PROTECTED)) {
    const url = new URL("/login", request.url);
    url.searchParams.set("next", pathname);
    return NextResponse.redirect(url);
  }
  if (user && matches(pathname, AUTH_ONLY_ANON)) {
    return NextResponse.redirect(new URL("/dashboard", request.url));
  }
  return response;
}
