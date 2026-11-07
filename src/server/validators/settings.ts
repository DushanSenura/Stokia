import { z } from "zod";

/** FormData gives "" for an empty box and null for an absent field: both mean "not provided". */
const blank = (v: unknown) => (v === null || v === undefined || (typeof v === "string" && v.trim() === "") ? undefined : v);

export const inviteSchema = z.object({
  email: z.string().trim().toLowerCase().pipe(z.email("auth.error.email")).refine((e) => e.length <= 254, "auth.error.email"),
  display_name: z.preprocess(blank, z.string().trim().max(80, "team.err.name").optional()),
  role: z.enum(["owner", "stock_manager", "viewer"], "team.err.role"),
});

export const roleSchema = z.enum(["owner", "stock_manager", "viewer"]);
export const statusSchema = z.enum(["active", "suspended"]);

export const VALUATION_POLICIES = ["cost_at_count", "latest_cost"] as const;

/** A short curated list plus every IANA zone the runtime knows; validated, never trusted. */
export function isValidTimezone(tz: string): boolean {
  try { new Intl.DateTimeFormat("en", { timeZone: tz }); return true; } catch { return false; }
}

export const shopSettingsSchema = z.object({
  name: z.string().trim().min(2, "setup.error.name").max(80, "setup.error.name"),
  timezone: z.string().refine(isValidTimezone, "set.err.timezone"),
  valuation_policy: z.enum(VALUATION_POLICIES, "set.err.policy"),
});

export const profileSchema = z.object({
  display_name: z.string().trim().min(1, "prof.err.name").max(80, "prof.err.name"),
  preferred_language: z.enum(["en", "si"], "prof.err.language"),
});

export const passwordSchema = z
  .object({ password: z.string().min(10, "auth.error.passwordShort").max(128), confirm: z.string() })
  .refine((v) => v.password === v.confirm, { path: ["confirm"], message: "auth.error.passwordMismatch" });

export const correctionRequestSchema = z.object({
  reason: z.string().trim().min(1, "cor.err.reason").max(300, "cor.err.reason"),
});
export const decisionSchema = z.object({ note: z.preprocess(blank, z.string().trim().max(300).optional()) });
