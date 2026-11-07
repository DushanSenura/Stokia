import { z } from "zod";
import { BASE_INVENTORY_UNITS, SIZE_UNITS } from "@/lib/formatting/units";

/** Messages are i18n keys. FormData sends "" for blanks, so blanks become undefined first. */
const blank = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);
const optional = <T extends z.ZodType>(s: T) => z.preprocess(blank, s.optional());

export const SKU_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{1,39}$/;
export const CODE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;
/** Up to 10 integer digits and 2 decimals. Kept as a string end-to-end (no float rounding). */
export const MONEY_RE = /^\d{1,10}(\.\d{1,2})?$/;
const QTY_RE = /^\d{1,12}(\.\d{1,3})?$/;

const uuid = z.string().uuid("auth.error.generic");

export const skuSchema = z.string().trim().regex(SKU_RE, "cat.error.sku");
export const moneySchema = z.string().trim().regex(MONEY_RE, "cat.error.money");

export const productSchema = z.object({
  name: z.string().trim().min(1, "cat.error.name").max(120, "cat.error.name"),
  product_code: z.string().trim().regex(CODE_RE, "cat.error.code"),
  category_id: optional(uuid),
  description: optional(z.string().trim().max(1000, "cat.error.description")),
});

export const variantSchema = z
  .object({
    sku: skuSchema,
    size_value: optional(z.string().trim().regex(QTY_RE, "cat.error.size")),
    size_unit: optional(z.enum(SIZE_UNITS, "cat.error.size")),
    base_inventory_unit: z.enum(BASE_INVENTORY_UNITS, "cat.error.baseUnit"),
    low_stock_threshold: z.preprocess((v) => (blank(v) === undefined ? "0" : v), z.string().trim().regex(QTY_RE, "cat.error.threshold")),
    barcode: optional(z.string().trim().max(64, "cat.error.barcode")),
  })
  .superRefine((v, ctx) => {
    // Size value and unit only make sense together; a zero size is meaningless.
    if (!!v.size_value !== !!v.size_unit) ctx.addIssue({ code: "custom", path: ["size_value"], message: "cat.error.size" });
    if (v.size_value && Number(v.size_value) <= 0) ctx.addIssue({ code: "custom", path: ["size_value"], message: "cat.error.size" });
  });

export const priceSchema = z.object({
  variant_id: uuid,
  price_type: z.enum(["selling", "purchase_cost"]),
  amount: moneySchema,
});

export const categorySchema = z.object({
  name: z.string().trim().min(1, "cat.error.name").max(60, "cat.error.name"),
  description: optional(z.string().trim().max(300)),
});

export const IMAGE_MAX_BYTES = 2 * 1024 * 1024;
export const IMAGE_TYPES = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" } as const;

/** Verify real file content (magic bytes), not just the client-declared MIME type. */
export function detectImageType(bytes: Uint8Array): keyof typeof IMAGE_TYPES | null {
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length > 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((b, i) => bytes[i] === b)) return "image/png";
  const tag = (o: number, s: string) => [...s].every((c, i) => bytes[o + i] === c.charCodeAt(0));
  if (bytes.length > 12 && tag(0, "RIFF") && tag(8, "WEBP")) return "image/webp";
  return null;
}
