import type { Metadata, Viewport } from "next";
import { SpeedInsights } from "@vercel/speed-insights/next";
import { Inter, Noto_Sans_Sinhala } from "next/font/google";
import { getLocale } from "@/i18n/server";
import { AppProviders } from "@/providers/app-providers";
import { THEME_SCRIPT } from "@/providers/theme-provider";
import "./globals.css";

const inter = Inter({ variable: "--font-inter", subsets: ["latin"], display: "swap" });
const sinhala = Noto_Sans_Sinhala({ variable: "--font-sinhala", subsets: ["sinhala"], display: "swap" });

export const metadata: Metadata = {
  title: { default: "Stokia — Count Today. Know Yesterday.", template: "%s · Stokia" },
  description:
    "A simpler way to manage daily stock, understand what sold yesterday, and keep your shop organized.",
  applicationName: "Stokia",
  // iPhone: "Add to Home Screen" opens Stokia full screen with its own icon and name.
  appleWebApp: { capable: true, title: "Stokia", statusBarStyle: "default" },
  icons: {
    icon: [
      { url: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
    apple: [{ url: "/icons/apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
  },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f8faf8" },
    { media: "(prefers-color-scheme: dark)", color: "#0e1512" },
  ],
};

export default async function RootLayout({ children }: LayoutProps<"/">) {
  const locale = await getLocale();
  return (
    <html lang={locale} className={`${inter.variable} ${sinhala.variable}`} suppressHydrationWarning>
      <head><script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} /></head>
      <body className="min-h-dvh">
        <AppProviders locale={locale}>{children}</AppProviders>
        <SpeedInsights />
      </body>
    </html>
  );
}
