import { NextResponse, type NextRequest } from "next/server";
import { IMPORT_COLUMNS } from "@/features/products/import";
import { toCsv } from "@/lib/exports/csv";
import { shopLocalDate } from "@/lib/dates/format";
import { exportCatalogRows } from "@/server/repositories/catalog";
import { getSessionContext } from "@/server/services/session";

const headers = (name: string) => ({
  "Content-Type": "text/csv; charset=utf-8",
  "Content-Disposition": `attachment; filename="${name}"`,
  "Cache-Control": "no-store",
});

/** Catalog export (same columns as the import template, so a round-trip works). Any member may export. */
export async function GET(request: NextRequest) {
  const ctx = await getSessionContext();
  if (!ctx.user || !ctx.membership) return new NextResponse("Unauthorized", { status: 401 });

  if (request.nextUrl.searchParams.get("template") === "1") {
    return new NextResponse(toCsv([[...IMPORT_COLUMNS], ["CHL", "Chilli Powder", "Spices", "", "CHL-250", "250", "g", "packet", "10", "350.00", "260.00", ""]]), { headers: headers("stokia-products-template.csv") });
  }

  const { products, prices } = await exportCatalogRows();
  const price = (variantId: string, type: string) => prices.find((p) => p.variant_id === variantId && p.price_type === type)?.amount_lkr ?? "";

  const rows: unknown[][] = [[...IMPORT_COLUMNS]];
  for (const p of products) {
    const category = Array.isArray(p.categories) ? p.categories[0]?.name : (p.categories as { name: string } | null)?.name;
    for (const v of p.product_variants) {
      rows.push([
        p.product_code, p.name, category ?? "", p.description ?? "", v.sku,
        v.size_value ? Number(v.size_value) : "", v.size_unit ?? "", v.base_inventory_unit, Number(v.low_stock_threshold),
        price(v.id, "selling"), price(v.id, "purchase_cost"), v.barcode ?? "",
      ]);
    }
  }
  const name = `stokia-products-${shopLocalDate(new Date(), ctx.membership.timezone)}.csv`;
  return new NextResponse(toCsv(rows), { headers: headers(name) });
}
