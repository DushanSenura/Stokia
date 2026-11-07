import { z } from "zod";

/** Messages are i18n keys, translated at render time. */
export const loginSchema = z.object({
  email: z.string().trim().toLowerCase().pipe(z.email("auth.error.email")),
  password: z.string().min(1, "auth.error.passwordRequired"),
});

export const resetRequestSchema = z.object({
  email: z.string().trim().toLowerCase().pipe(z.email("auth.error.email")),
});

export const updatePasswordSchema = z
  .object({
    password: z.string().min(10, "auth.error.passwordShort").max(128),
    confirm: z.string(),
  })
  .refine((v) => v.password === v.confirm, { path: ["confirm"], message: "auth.error.passwordMismatch" });

export const createShopSchema = z.object({
  name: z.string().trim().min(2, "setup.error.name").max(80, "setup.error.name"),
  currency: z.literal("LKR").default("LKR"),
  timezone: z.string().refine((tz) => {
    try {
      new Intl.DateTimeFormat("en", { timeZone: tz });
      return true;
    } catch {
      return false;
    }
  }, "auth.error.generic"),
});

/** Only allow same-site relative redirects (blocks open redirects like //evil.com). */
export function safeNextPath(next: unknown, fallback = "/dashboard"): string {
  if (typeof next !== "string") return fallback;
  if (!next.startsWith("/") || next.startsWith("//") || next.includes("\\")) return fallback;
  return next;
}
