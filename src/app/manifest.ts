import type { MetadataRoute } from "next";

/** Web app manifest: what makes Stokia installable on Android (Chrome) and the iPhone home screen (via Safari). */
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/",
    name: "Stokia — Count Today. Know Yesterday.",
    short_name: "Stokia",
    description: "Daily stock and estimated sales for your shop.",
    start_url: "/dashboard",
    scope: "/",
    display: "standalone",
    background_color: "#F8FAF8",
    theme_color: "#1F6B50",
    lang: "en",
    categories: ["business", "productivity"],
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
    shortcuts: [
      { name: "Enter stock sheet", short_name: "Stock sheet", url: "/morning-stock", icons: [{ src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" }] },
    ],
  };
}
