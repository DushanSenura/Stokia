/*
 * Stokia service worker.
 *
 * Deliberately small and conservative. It exists to (1) make the app installable, (2) keep the app's own static files
 * available on a poor connection, and (3) show a friendly page instead of the browser's error when the app is opened
 * with no connection at all.
 *
 * What it NEVER does:
 *   - cache or answer anything from /api/ (reports, exports, notifications, backups: all private shop data);
 *   - cache page navigations or Next.js data (RSC) requests, which contain the signed-in shop's data;
 *   - touch requests to other origins (Supabase auth, database, storage);
 *   - handle anything but GET.
 * Counts entered offline are NOT handled here: the page keeps them in IndexedDB and sends them with an idempotency key.
 *
 * Updates: a new worker waits until the person taps "Update now" (message SKIP_WAITING), so an update can never reload the
 * page in the middle of a count.
 */
const VERSION = "v1";
const SHELL_CACHE = "stokia-shell-" + VERSION;
const ASSET_CACHE = "stokia-assets-" + VERSION;
const OFFLINE_URL = "/offline.html";
const PRECACHE = [OFFLINE_URL, "/icons/icon-192.png", "/icons/icon-512.png", "/branding/stokia-mark-256.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(SHELL_CACHE).then((cache) => cache.addAll(PRECACHE)));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      for (const name of await caches.keys()) {
        if (name !== SHELL_CACHE && name !== ASSET_CACHE) await caches.delete(name);
      }
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") self.skipWaiting();
});

/** Files that are the same for every visitor and safe to keep: hashed build output, icons and the logo. */
function isStaticAsset(url) {
  return url.pathname.startsWith("/_next/static/") || url.pathname.startsWith("/icons/") || url.pathname.startsWith("/branding/");
}

async function cacheFirst(request) {
  const hit = await caches.match(request);
  if (hit) return hit;
  const response = await fetch(request);
  if (response && response.ok && response.type === "basic") {
    const copy = response.clone();
    caches.open(ASSET_CACHE).then((cache) => cache.put(request, copy));
  }
  return response;
}

/** Always go to the network for pages; only if there is no connection at all, show the offline page. */
async function networkOrOffline(request) {
  try {
    return await fetch(request);
  } catch {
    return (await caches.match(OFFLINE_URL)) || Response.error();
  }
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // Supabase and anything else: not ours to touch
  if (url.pathname.startsWith("/api/")) return; // private data: never cached
  if (url.searchParams.has("_rsc") || request.headers.get("RSC")) return; // Next.js data for the signed-in shop
  if (isStaticAsset(url)) {
    event.respondWith(cacheFirst(request));
    return;
  }
  if (request.mode === "navigate") {
    event.respondWith(networkOrOffline(request));
  }
  // anything else: left to the network, untouched
});
