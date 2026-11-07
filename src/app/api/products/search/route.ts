import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getSessionContext } from "@/server/services/session";

export interface ProductHit { id: string; name: string; code: string }
const clean = (s: string) => s.replace(/[,()%*_\\"']/g, " ").trim().slice(0, 60);

/** Type-ahead product search for filters. Includes archived products (history can be filtered by them). RLS scopes it to the caller's shop. */
export async function GET(request: NextRequest) {
  const ctx = await getSessionContext();
  if (!ctx.user || !ctx.membership) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const term = clean(request.nextUrl.searchParams.get("q") ?? "");
  if (!term) return NextResponse.json({ hits: [] satisfies ProductHit[] });
  const { data } = await (await createClient()).from("products").select("id,name,product_code").or(`name.ilike.%${term}%,product_code.ilike.%${term}%`).order("name").limit(12);
  return NextResponse.json({ hits: (data ?? []).map((p) => ({ id: p.id, name: p.name, code: p.product_code })) }, { headers: { "Cache-Control": "no-store" } });
}
