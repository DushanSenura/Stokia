import type { NextConfig } from "next";

const isProd = process.env.NODE_ENV === "production";

/** Where the browser may talk to besides this site: the project's Supabase URL (REST/Auth/Storage + realtime socket). */
function supabaseOrigins(): string[] {
  try {
    const u = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "");
    return [u.origin, `wss://${u.host}`];
  } catch {
    return [];
  }
}

/**
 * Content Security Policy. Next.js injects small inline bootstrap scripts and the UI uses inline style attributes, so
 * 'unsafe-inline' is still needed for script/style. Everything else is locked down: no plugins, no framing, no foreign
 * base URIs or form targets, and network calls only to this site and the Supabase project.
 * (A nonce-based policy would need every page rendered per request; that trade-off is documented in docs/deployment.md.)
 */
const csp = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  `img-src 'self' data: blob: ${supabaseOrigins()[0] ?? ""}`.trim(),
  "font-src 'self' data:",
  `connect-src 'self' ${supabaseOrigins().join(" ")}`.trim(),
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  // Browsers would rewrite http://localhost requests to https and fail; the test server over plain http opts out.
  ...(process.env.STOKIA_PLAIN_HTTP === "1" ? [] : ["upgrade-insecure-requests"]),
].join("; ");

const securityHeaders = [
  { key: "Content-Security-Policy", value: csp },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()" },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
];

const nextConfig: NextConfig = {
  poweredByHeader: false,
  // Headers are only added in production: the dev server needs eval/HMR sockets that this policy (rightly) forbids.
  async headers() {
    if (!isProd) return [];
    return [
      { source: "/:path*", headers: securityHeaders },
      // The service worker file itself must never be cached by the browser, or updates would never arrive.
      { source: "/sw.js", headers: [{ key: "Content-Type", value: "application/javascript; charset=utf-8" }, { key: "Cache-Control", value: "no-cache, no-store, must-revalidate" }] },
    ];
  },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
