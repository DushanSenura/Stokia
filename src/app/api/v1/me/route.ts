import { authenticate, json, preflight } from "@/server/api/v1";

export const dynamic = "force-dynamic";
export const OPTIONS = preflight;

/** Who is signed in and which shops they belong to (with their role in each). */
export async function GET(request: Request) {
  const a = await authenticate(request);
  if (!a.ok) return a.response;
  const { userId, email, displayName, memberships } = a.ctx;
  return json(request, { ok: true, user: { id: userId, email, displayName }, memberships });
}
