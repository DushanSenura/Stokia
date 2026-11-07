// @vitest-environment node
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Runs the real public/sw.js in a sandbox with stubbed browser APIs and checks what it does and, more importantly,
 * what it refuses to touch: private data must never be cached or answered by the worker.
 */
const source = fs.readFileSync(path.resolve(__dirname, "../../public/sw.js"), "utf8");
const ORIGIN = "https://stokia.example";

type Listener = (event: unknown) => void;
interface Harness {
  listeners: Record<string, Listener>;
  cache: { addAll: ReturnType<typeof vi.fn>; put: ReturnType<typeof vi.fn> };
  matchResult: { current: unknown };
  fetchImpl: ReturnType<typeof vi.fn>;
  deleted: string[];
  skipWaiting: ReturnType<typeof vi.fn>;
  claim: ReturnType<typeof vi.fn>;
  cacheKeys: string[];
}

function load(): Harness {
  const listeners: Record<string, Listener> = {};
  const cache = { addAll: vi.fn().mockResolvedValue(undefined), put: vi.fn().mockResolvedValue(undefined) };
  const matchResult: { current: unknown } = { current: undefined };
  const fetchImpl = vi.fn();
  const deleted: string[] = [];
  const skipWaiting = vi.fn();
  const claim = vi.fn().mockResolvedValue(undefined);
  const cacheKeys = ["stokia-shell-v0", "stokia-shell-v1", "stokia-assets-v1", "someone-elses-cache"];
  const self = {
    location: { origin: ORIGIN },
    addEventListener: (type: string, fn: Listener) => { listeners[type] = fn; },
    skipWaiting, clients: { claim },
  };
  const sandbox = {
    self, URL, Response, console,
    fetch: fetchImpl,
    caches: {
      open: vi.fn().mockResolvedValue(cache),
      match: vi.fn(async () => matchResult.current),
      keys: vi.fn(async () => cacheKeys),
      delete: vi.fn(async (name: string) => { deleted.push(name); return true; }),
    },
  };
  vm.runInNewContext(source, sandbox);
  return { listeners, cache, matchResult, fetchImpl, deleted, skipWaiting, claim, cacheKeys };
}

interface Req { method?: string; path: string; mode?: string; headers?: Record<string, string>; origin?: string }
function fetchEvent(r: Req) {
  const headers = r.headers ?? {};
  const request = { method: r.method ?? "GET", url: `${r.origin ?? ORIGIN}${r.path}`, mode: r.mode ?? "cors", headers: { get: (k: string) => headers[k] ?? null } };
  const event = { request, respondWith: vi.fn() };
  return event;
}
const responded = (e: { respondWith: ReturnType<typeof vi.fn> }) => e.respondWith.mock.calls.length > 0;

let sw: Harness;
beforeEach(() => { sw = load(); });

describe("what the worker refuses to touch (private data)", () => {
  const untouched: [string, Req][] = [
    ["a POST (server actions, form posts)", { method: "POST", path: "/morning-stock", mode: "navigate" }],
    ["the API (reports, exports, notifications, backups)", { path: "/api/exports/backup", mode: "navigate" }],
    ["an API call from the page", { path: "/api/notifications" }],
    ["a report download", { path: "/api/reports/2026-10/pdf" }],
    ["Next.js data requests (?_rsc)", { path: "/dashboard?_rsc=abc" }],
    ["Next.js data requests (RSC header)", { path: "/dashboard", headers: { RSC: "1" } }],
    ["another origin (Supabase auth, database, storage)", { path: "/rest/v1/products", origin: "https://abc.supabase.co" }],
    ["a script or image that is not a fixed app asset", { path: "/some-user-upload.png" }],
  ];
  for (const [label, req] of untouched) {
    it(`does not handle ${label}`, () => {
      const e = fetchEvent(req);
      sw.listeners.fetch(e);
      expect(responded(e)).toBe(false);
    });
  }
});

describe("static app files", () => {
  it("serves a cached copy without touching the network", async () => {
    const hit = new Response("chunk");
    sw.matchResult.current = hit;
    const e = fetchEvent({ path: "/_next/static/chunks/app.js" });
    sw.listeners.fetch(e);
    expect(await e.respondWith.mock.calls[0][0]).toBe(hit);
    expect(sw.fetchImpl).not.toHaveBeenCalled();
  });

  /** A real same-origin fetch gives `type: "basic"`; the Response constructor alone does not, so set it. */
  const typed = (body: string, type: ResponseType, status = 200) => {
    const res = new Response(body, { status });
    Object.defineProperty(res, "type", { value: type });
    return res;
  };

  it("never keeps an opaque (cross-origin) response", async () => {
    sw.matchResult.current = undefined;
    sw.fetchImpl.mockResolvedValue(typed("x", "opaque"));
    const e = fetchEvent({ path: "/icons/icon-192.png" });
    sw.listeners.fetch(e);
    await e.respondWith.mock.calls[0][0];
    await Promise.resolve();
    expect(sw.cache.put).not.toHaveBeenCalled();
  });

  it("fetches and keeps a file it has not seen, but only successful same-origin responses", async () => {
    sw.matchResult.current = undefined;
    sw.fetchImpl.mockResolvedValue(typed("ok", "basic"));
    const e = fetchEvent({ path: "/icons/icon-192.png" });
    sw.listeners.fetch(e);
    await e.respondWith.mock.calls[0][0];
    await Promise.resolve();
    expect(sw.fetchImpl).toHaveBeenCalledTimes(1);
    expect(sw.cache.put).toHaveBeenCalledTimes(1);

    sw.cache.put.mockClear();
    sw.fetchImpl.mockResolvedValue(typed("missing", "basic", 404));
    const bad = fetchEvent({ path: "/_next/static/chunks/gone.js" });
    sw.listeners.fetch(bad);
    await bad.respondWith.mock.calls[0][0];
    await Promise.resolve();
    expect(sw.cache.put).not.toHaveBeenCalled();
  });
});

describe("page navigations", () => {
  it("always uses the network and NEVER stores the page (it contains the signed-in shop's data)", async () => {
    const page = new Response("<html>private</html>");
    sw.fetchImpl.mockResolvedValue(page);
    const e = fetchEvent({ path: "/dashboard", mode: "navigate" });
    sw.listeners.fetch(e);
    expect(await e.respondWith.mock.calls[0][0]).toBe(page);
    expect(sw.cache.put).not.toHaveBeenCalled();
  });

  it("shows the offline page only when there is no connection at all", async () => {
    const offline = new Response("offline page");
    sw.matchResult.current = offline;
    sw.fetchImpl.mockRejectedValue(new TypeError("Failed to fetch"));
    const e = fetchEvent({ path: "/morning-stock", mode: "navigate" });
    sw.listeners.fetch(e);
    expect(await e.respondWith.mock.calls[0][0]).toBe(offline);
  });

  it("passes a server error (e.g. 500) straight through instead of hiding it behind the offline page", async () => {
    const boom = new Response("server error", { status: 500 });
    sw.fetchImpl.mockResolvedValue(boom);
    const e = fetchEvent({ path: "/dashboard", mode: "navigate" });
    sw.listeners.fetch(e);
    expect(await e.respondWith.mock.calls[0][0]).toBe(boom);
  });
});

describe("lifecycle", () => {
  it("installs by keeping the offline page and the app icon, and does NOT take over until the person agrees", async () => {
    let work: Promise<unknown> = Promise.resolve();
    sw.listeners.install({ waitUntil: (p: Promise<unknown>) => { work = p; } });
    await work;
    const urls = sw.cache.addAll.mock.calls[0][0] as string[];
    expect(urls).toContain("/offline.html");
    expect(urls).toContain("/icons/icon-192.png");
    expect(sw.skipWaiting).not.toHaveBeenCalled();
  });

  it("an update is applied only when the page asks for it", () => {
    sw.listeners.message({ data: { type: "SOMETHING_ELSE" } });
    expect(sw.skipWaiting).not.toHaveBeenCalled();
    sw.listeners.message({ data: { type: "SKIP_WAITING" } });
    expect(sw.skipWaiting).toHaveBeenCalledTimes(1);
    sw.listeners.message({});
    expect(sw.skipWaiting).toHaveBeenCalledTimes(1);
  });

  it("on activation removes its own old caches (and only its own) and takes control", async () => {
    let work: Promise<unknown> = Promise.resolve();
    sw.listeners.activate({ waitUntil: (p: Promise<unknown>) => { work = p; } });
    await work;
    // everything not belonging to the current version is deleted — including a foreign name, which only matters for same-origin caches
    expect(sw.deleted).toContain("stokia-shell-v0");
    expect(sw.deleted).not.toContain("stokia-shell-v1");
    expect(sw.deleted).not.toContain("stokia-assets-v1");
    expect(sw.claim).toHaveBeenCalled();
  });
});

describe("the file itself", () => {
  it("contains no key, token or credential", () => {
    expect(source).not.toMatch(/service_role|sb_(publishable|secret)|eyJ[A-Za-z0-9]|bearer|apikey/i);
  });
});
