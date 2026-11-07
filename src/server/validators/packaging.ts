import { z } from "zod";

const blank = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);

/** Factor stays a decimal string (never a float): up to 7 integer digits, 6 decimals, above zero. */
export const FACTOR_RE = /^\d{1,7}(\.\d{1,6})?$/;

export const packagingUnitSchema = z.object({
  name: z.string().trim().min(1, "pk.err.empty_name").max(40, "pk.err.empty_name"),
  /** Empty = made of base units. */
  parent_unit_id: z.preprocess(blank, z.string().uuid("pk.err.unknown_parent").optional()),
  conversion_factor: z
    .string()
    .trim()
    .regex(FACTOR_RE, "pk.err.invalid_factor")
    .refine((v) => Number(v) > 0, "pk.err.invalid_factor"),
});

export type PackagingUnitInput = z.infer<typeof packagingUnitSchema>;
