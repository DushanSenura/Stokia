import { z } from "zod";
import { MONEY_RE } from "./catalog";

const blank = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);
const opt = <T extends z.ZodType>(s: T) => z.preprocess(blank, s.optional());

/** Movement types a user can record directly. Repacking has its own form (it touches two variants). */
export const FORM_MOVEMENT_TYPES = [
  "stock_received", "customer_return", "supplier_return", "damaged", "expired", "discarded", "manual_adjustment",
] as const;

export const QTY_RE = /^\d{1,9}(\.\d{1,3})?$/;
const uuid = z.string().uuid("auth.error.generic");
const key = z.string().trim().min(8, "auth.error.generic").max(80, "auth.error.generic");
const qty = z.string().trim().regex(QTY_RE, "mv.err.quantity").refine((v) => Number(v) > 0, "mv.err.quantity");

export const movementSchema = z.object({
  variant_id: uuid,
  type: z.enum(FORM_MOVEMENT_TYPES, "mv.err.type"),
  direction: opt(z.enum(["in", "out"])),
  unit_id: opt(uuid),
  quantity: qty,
  when: z.enum(["now", "before_count", "custom"]).default("now"),
  effective_local: opt(z.string().trim().max(16)),
  reason: opt(z.string().trim().max(300)),
  reference: opt(z.string().trim().max(120)),
  supplier: opt(z.string().trim().max(120)),
  cost: opt(z.string().trim().regex(MONEY_RE, "cat.error.money")),
  key,
}).superRefine((v, ctx) => {
  if (v.type === "manual_adjustment" && !v.direction) ctx.addIssue({ code: "custom", path: ["direction"], message: "mv.err.direction" });
  if (!v.reason && !v.reference) ctx.addIssue({ code: "custom", path: ["reason"], message: "mv.err.reason" });
  if (v.when === "custom" && !v.effective_local) ctx.addIssue({ code: "custom", path: ["effective_local"], message: "mv.err.time" });
});

export const repackSchema = z.object({
  from_variant: uuid, from_unit: opt(uuid), from_quantity: qty,
  to_variant: uuid, to_unit: opt(uuid), to_quantity: qty,
  when: z.enum(["now", "custom"]).default("now"),
  effective_local: opt(z.string().trim().max(16)),
  reason: z.string().trim().min(1, "mv.err.reason").max(300),
  key,
}).superRefine((v, ctx) => {
  if (v.from_variant === v.to_variant) ctx.addIssue({ code: "custom", path: ["to_variant"], message: "mv.err.sameVariant" });
  if (v.when === "custom" && !v.effective_local) ctx.addIssue({ code: "custom", path: ["effective_local"], message: "mv.err.time" });
});

export const reverseSchema = z.object({ reason: z.string().trim().min(1, "mv.err.reason").max(300), key });
