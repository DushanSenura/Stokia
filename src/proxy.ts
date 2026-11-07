import type { NextRequest } from "next/server";
import { updateSession } from "@/lib/supabase/proxy";

export async function proxy(request: NextRequest) {
  return updateSession(request);
}

export const config = {
  // Static files, the service worker, the manifest and the offline page are public and need no session check.
  // /api/v1 is for the phone apps: it authenticates with a bearer token, not the browser's cookie session.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|sw.js|offline.html|manifest.webmanifest|api/v1|branding|icons|images|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)"],
};
