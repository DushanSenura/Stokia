"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { FormState } from "@/server/actions/auth";
import { requireRole, mapDbError } from "@/server/services/guard";
import {
  categorySchema, detectImageType, IMAGE_MAX_BYTES, IMAGE_TYPES, priceSchema, productSchema, variantSchema,
} from "@/server/validators/catalog";
import { hasBlockingErrors, MAX_IMPORT_BYTES, validateImport, type ImportResult } from "@/features/products/import";
import type { MessageKey } from "@/i18n";
import { rolesFor } from "@/server/permissions";

const OWNER = rolesFor("catalog.write");

function invalid(issues: { path: PropertyKey[]; message: string }[]): FormState {
  const fieldErrors: Record<string, MessageKey> = {};
  for (const i of issues) fieldErrors[String(i.path[0] ?? "form")] ??= i.message as MessageKey;
  return { fieldErrors };
}
const form = (fd: FormData) => Object.fromEntries(fd);
const nullIfBlank = <T>(v: T | undefined) => (v === undefined || v === "" ? null : v);

// ---------- products ----------
export async function createProductAction(_: FormState, fd: FormData): Promise<FormState> {
  const g = await requireRole(OWNER);
  if (!g.ok) return { error: g.error };
  const p = productSchema.safeParse(form(fd));
  if (!p.success) return invalid(p.error.issues);

  const { data, error } = await g.supabase
    .from("products")
    .insert({ shop_id: g.shopId, name: p.data.name, product_code: p.data.product_code, category_id: nullIfBlank(p.data.category_id), description: nullIfBlank(p.data.description) })
    .select("id").single();
  if (error) return { error: mapDbError(error) };
  revalidatePath("/products");
  redirect(`/products/${data.id}`);
}

export async function updateProductAction(productId: string, _: FormState, fd: FormData): Promise<FormState> {
  const g = await requireRole(OWNER);
  if (!g.ok) return { error: g.error };
  const p = productSchema.safeParse(form(fd));
  if (!p.success) return invalid(p.error.issues);
  const { error } = await g.supabase.from("products").update({
    name: p.data.name, product_code: p.data.product_code, category_id: nullIfBlank(p.data.category_id), description: nullIfBlank(p.data.description),
  }).eq("id", productId);
  if (error) return { error: mapDbError(error) };
  revalidatePath("/products"); revalidatePath(`/products/${productId}`);
  return { success: "common.saved" };
}

/** Archive/restore. Products are never hard-deleted (history must stay traceable). */
export async function setProductActiveAction(productId: string, active: boolean) {
  const g = await requireRole(OWNER);
  if (!g.ok) return;
  await g.supabase.from("products").update({ is_active: active }).eq("id", productId);
  revalidatePath("/products"); revalidatePath(`/products/${productId}`);
}

export async function uploadProductImageAction(productId: string, _: FormState, fd: FormData): Promise<FormState> {
  const g = await requireRole(OWNER);
  if (!g.ok) return { error: g.error };
  const file = fd.get("image");
  if (!(file instanceof File) || file.size === 0) return { error: "cat.error.imageType" };
  if (file.size > IMAGE_MAX_BYTES) return { error: "cat.error.imageSize" };

  const bytes = new Uint8Array(await file.arrayBuffer());
  const type = detectImageType(bytes); // trust content, not the declared type/extension
  if (!type) return { error: "cat.error.imageType" };

  const path = `${g.shopId}/${productId}-${randomUUID()}.${IMAGE_TYPES[type]}`;
  const { error: upErr } = await g.supabase.storage.from("product-images").upload(path, bytes, { contentType: type, upsert: false });
  if (upErr) return { error: "auth.error.generic" };
  const { data: pub } = g.supabase.storage.from("product-images").getPublicUrl(path);
  const { error } = await g.supabase.from("products").update({ image_url: pub.publicUrl }).eq("id", productId);
  if (error) return { error: mapDbError(error) };
  revalidatePath(`/products/${productId}`);
  return { success: "common.saved" };
}

// ---------- variants ----------
export async function createVariantAction(productId: string, _: FormState, fd: FormData): Promise<FormState> {
  const g = await requireRole(OWNER);
  if (!g.ok) return { error: g.error };
  const v = variantSchema.safeParse(form(fd));
  if (!v.success) return invalid(v.error.issues);
  const { error } = await g.supabase.from("product_variants").insert({
    product_id: productId, shop_id: g.shopId, sku: v.data.sku, size_value: nullIfBlank(v.data.size_value), size_unit: nullIfBlank(v.data.size_unit),
    base_inventory_unit: v.data.base_inventory_unit, low_stock_threshold: v.data.low_stock_threshold, barcode: nullIfBlank(v.data.barcode),
  });
  if (error) return { error: mapDbError(error) };
  revalidatePath(`/products/${productId}`);
  return { success: "common.saved" };
}

export async function updateVariantAction(productId: string, variantId: string, _: FormState, fd: FormData): Promise<FormState> {
  const g = await requireRole(OWNER);
  if (!g.ok) return { error: g.error };
  const v = variantSchema.safeParse(form(fd));
  if (!v.success) return invalid(v.error.issues);
  // base_inventory_unit is not editable once a variant exists: changing it would silently
  // reinterpret every historical count. (A proper repacking flow comes with Phase 3.)
  const { error } = await g.supabase.from("product_variants").update({
    sku: v.data.sku, size_value: nullIfBlank(v.data.size_value), size_unit: nullIfBlank(v.data.size_unit),
    low_stock_threshold: v.data.low_stock_threshold, barcode: nullIfBlank(v.data.barcode),
  }).eq("id", variantId).eq("product_id", productId);
  if (error) return { error: mapDbError(error) };
  revalidatePath(`/products/${productId}`);
  return { success: "common.saved" };
}

export async function setVariantActiveAction(productId: string, variantId: string, active: boolean) {
  const g = await requireRole(OWNER);
  if (!g.ok) return;
  await g.supabase.from("product_variants").update({ is_active: active }).eq("id", variantId).eq("product_id", productId);
  revalidatePath(`/products/${productId}`);
}

export async function setPriceAction(productId: string, _: FormState, fd: FormData): Promise<FormState> {
  const g = await requireRole(OWNER);
  if (!g.ok) return { error: g.error };
  const p = priceSchema.safeParse(form(fd));
  if (!p.success) return invalid(p.error.issues);
  const { error } = await g.supabase.rpc("set_variant_price", { p_variant: p.data.variant_id, p_type: p.data.price_type, p_amount: Number(p.data.amount) });
  if (error) return { error: mapDbError(error) };
  revalidatePath(`/products/${productId}`);
  return { success: "common.saved" };
}

// ---------- categories ----------
export async function createCategoryAction(_: FormState, fd: FormData): Promise<FormState> {
  const g = await requireRole(OWNER);
  if (!g.ok) return { error: g.error };
  const c = categorySchema.safeParse(form(fd));
  if (!c.success) return invalid(c.error.issues);
  const { error } = await g.supabase.from("categories").insert({ shop_id: g.shopId, name: c.data.name, description: nullIfBlank(c.data.description) });
  if (error) return { error: mapDbError(error) };
  revalidatePath("/products/categories");
  return { success: "common.saved" };
}

export async function renameCategoryAction(categoryId: string, _: FormState, fd: FormData): Promise<FormState> {
  const g = await requireRole(OWNER);
  if (!g.ok) return { error: g.error };
  const c = categorySchema.safeParse(form(fd));
  if (!c.success) return invalid(c.error.issues);
  const { error } = await g.supabase.from("categories").update({ name: c.data.name, description: nullIfBlank(c.data.description) }).eq("id", categoryId);
  if (error) return { error: mapDbError(error) };
  revalidatePath("/products/categories");
  return { success: "common.saved" };
}

// ---------- import ----------
export interface ImportState extends FormState {
  result?: Pick<ImportResult, "errors" | "rowCount"> & { productCount: number; variantCount: number };
  committed?: boolean;
}

/** mode=preview validates only; mode=commit validates again server-side, then imports atomically. */
export async function importProductsAction(_: ImportState, fd: FormData): Promise<ImportState> {
  const g = await requireRole(OWNER);
  if (!g.ok) return { error: g.error };
  const file = fd.get("file");
  if (!(file instanceof File) || file.size === 0) return { error: "cat.import.noFile" };
  if (file.size > MAX_IMPORT_BYTES) return { error: "cat.import.tooLarge" };
  if (!/\.csv$/i.test(file.name)) return { error: "cat.import.csvOnly" };

  const parsed = validateImport(await file.text());
  const summary = {
    errors: parsed.errors.slice(0, 50), rowCount: parsed.rowCount,
    productCount: parsed.products.length, variantCount: parsed.products.reduce((n, p) => n + p.variants.length, 0),
  };
  if (hasBlockingErrors(parsed)) return { result: summary };
  if (fd.get("mode") !== "commit") return { result: summary };

  const { error } = await g.supabase.rpc("import_catalog", { p_shop: g.shopId, p_products: parsed.products });
  if (error) return { error: mapDbError(error), result: summary };
  revalidatePath("/products");
  return { result: summary, committed: true, success: "cat.import.done" };
}
