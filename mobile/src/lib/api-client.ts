import type { ProductCatalog } from "@/features/inventory/catalog-types";
import type { EntryItem, FieldValues } from "@/features/inventory/count-entry";
import type { CountInput, CountResult, SalesSummary } from "@/features/inventory/count-types";
import type { MonthlyReport, ReportIndexRow } from "@/features/reports/report";

/**
 * The phone's client for the Stokia server API (/api/v1). Pure and injectable, so it is tested without a phone.
 *
 * The contract that matters for the offline queue:
 *  - the server ANSWERED (any 2xx/4xx)  -> a value is returned (a refusal or a conflict is an answer, not an error);
 *  - NO ANSWER (network failure, timeout, 5xx) -> `ApiUnreachable` is THROWN, so the queue keeps the count and replays the SAME
 *    idempotency key later. Never swallowed, never turned into a "failure" that would discard the count.
 */
export class ApiUnreachable extends Error {
  constructor(message = "unreachable") { super(message); this.name = "ApiUnreachable"; }
}
/** The session is no longer valid (even after a refresh): the person has to sign in again. */
export class ApiSignedOut extends Error {
  constructor() { super("signed_out"); this.name = "ApiSignedOut"; }
}

export interface ApiDeps {
  baseUrl: string;
  getToken: () => Promise<string | null>;
  /** Refresh the session and return the new access token (null if that is no longer possible). */
  refresh: () => Promise<string | null>;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export interface Membership { shopId: string; shopName: string; timezone: string; role: "owner" | "stock_manager" | "viewer" }
export interface MeResponse { ok: true; user: { id: string; email: string | null; displayName: string }; memberships: Membership[] }
export interface HomeResponse {
  ok: true; shop: Membership; today: string; todayStatus: "not_started" | "draft" | "confirmed";
  latestConfirmed: string | null; salesDate: string | null; sales: SalesSummary | null;
}
export interface MorningStockResponse {
  ok: true; shop: Membership; canWrite: boolean;
  businessDate: string; salesDate: string; confirmedSessionId: string | null;
  items: EntryItem[]; initialValues: Record<string, FieldValues>; session: { id: string; revision: number } | null;
  previousDate: string | null; gapDays: number; truncated: boolean;
}

export interface ProductsResponse extends ProductCatalog { ok: true; shop: Membership }
export interface RecentCount { id: string; businessDate: string; status: string; confirmedAt: string | null; by: string | null; counted: number; notCounted: number }
export interface ReportsResponse { ok: true; shop: Membership; months: ReportIndexRow[]; recent: RecentCount[] }
/** The monthly report as the phone receives it: the per-variant table is left out (per-product totals are included). */
export type PhoneReport = Omit<MonthlyReport, "variants">;
export interface ReportResponse { ok: true; report: PhoneReport }
export type ReportFileFormat = "pdf" | "xlsx" | "csv";
export interface ReportFile { bytes: Uint8Array; fileName: string; mime: string }

/** A file name that is safe to write into the app's cache: no folders, no odd characters, never empty. */
export function safeFileName(raw: string | null | undefined, fallback: string): string {
  const name = (raw ?? "").replace(/[\\/]+/g, " ").replace(/[^\w.\- ()]+/g, "").trim().replace(/^\.+/, "").slice(0, 80);
  return name || fallback;
}

export function createApi(deps: ApiDeps) {
  const doFetch = deps.fetch ?? fetch;
  const base = deps.baseUrl.replace(/\/+$/, "");

  async function call(path: string, init: { method?: "GET" | "POST"; body?: unknown; binary?: boolean } = {}): Promise<{ status: number; body: unknown; headers: Headers }> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = attempt === 0 ? await deps.getToken() : await deps.refresh();
      if (!token) throw new ApiSignedOut();

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? 20_000);
      let res: Response;
      try {
        res = await doFetch(`${base}${path}`, {
          method: init.method ?? "GET",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json" },
          body: init.body === undefined ? undefined : JSON.stringify(init.body),
          signal: controller.signal,
        });
      } catch {
        throw new ApiUnreachable(); // offline, DNS, TLS, timeout
      } finally {
        clearTimeout(timer);
      }

      if (res.status === 401 && attempt === 0) continue; // the access token may simply have expired: refresh once and retry
      if (res.status === 401) throw new ApiSignedOut();
      if (res.status >= 500) throw new ApiUnreachable(`HTTP ${res.status}`);
      const body: unknown = init.binary && res.status === 200 ? await res.arrayBuffer() : await res.json().catch(() => null);
      return { status: res.status, body, headers: res.headers };
    }
    throw new ApiSignedOut();
  }

  /** Reads: anything but a clean 200 answer is an error the screen can show (or fall back to its saved copy for). */
  async function read<T>(path: string): Promise<T> {
    const { status, body } = await call(path);
    if (status === 403) throw new ApiForbidden();
    if (status !== 200 || !body || (body as { ok?: boolean }).ok !== true) throw new ApiUnreachable(`HTTP ${status}`);
    return body as T;
  }

  return {
    me: () => read<MeResponse>("/api/v1/me"),
    home: (shopId: string) => read<HomeResponse>(`/api/v1/home?shop=${encodeURIComponent(shopId)}`),
    morningStock: (shopId: string, date?: string) =>
      read<MorningStockResponse>(`/api/v1/morning-stock?shop=${encodeURIComponent(shopId)}${date ? `&date=${encodeURIComponent(date)}` : ""}`),
    products: (shopId: string) => read<ProductsResponse>(`/api/v1/products?shop=${encodeURIComponent(shopId)}`),
    reports: (shopId: string) => read<ReportsResponse>(`/api/v1/reports?shop=${encodeURIComponent(shopId)}`),
    report: (shopId: string, month: string) => read<ReportResponse>(`/api/v1/reports/${encodeURIComponent(month)}?shop=${encodeURIComponent(shopId)}`),

    /** The same PDF / Excel / CSV file the web app downloads, as bytes for the phone's share sheet. */
    async reportFile(shopId: string, month: string, format: ReportFileFormat): Promise<ReportFile> {
      const { status, body, headers } = await call(`/api/v1/reports/${encodeURIComponent(month)}/file?shop=${encodeURIComponent(shopId)}&format=${format}`, { binary: true });
      if (status === 403) throw new ApiForbidden();
      if (status !== 200 || !(body instanceof ArrayBuffer)) throw new ApiUnreachable(`HTTP ${status}`);
      const named = /filename="?([^";]+)"?/i.exec(headers.get("content-disposition") ?? "")?.[1];
      return { bytes: new Uint8Array(body), fileName: safeFileName(named, `Stokia-${month}.${format}`), mime: headers.get("content-type")?.split(";")[0] ?? "application/octet-stream" };
    },

    async variantLabels(shopId: string, ids: string[]): Promise<Record<string, string>> {
      const { status, body } = await call("/api/v1/variant-labels", { method: "POST", body: { shopId, ids } });
      return status === 200 && body && typeof (body as { labels?: unknown }).labels === "object" ? ((body as { labels: Record<string, string> }).labels) : {};
    },

    /** Save and confirm a count. Throws `ApiUnreachable` / `ApiSignedOut` when there is no usable answer. */
    async submitCount(a: { shopId: string; count: CountInput; ackMissing: boolean; key: string; device?: string }): Promise<CountResult> {
      const { status, body } = await call("/api/v1/counts", {
        method: "POST",
        body: { shopId: a.shopId, count: a.count, ackMissing: a.ackMissing, idempotencyKey: a.key, device: a.device },
      });
      if (status === 200 && body && typeof (body as { ok?: unknown }).ok === "boolean") return body as CountResult;
      if (status === 403) return { ok: false, error: "error.forbidden" };
      return { ok: false, error: "ms.err.INVALID_PAYLOAD" }; // 400 and anything unexpected: a refusal the person can see, not a retry loop
    },
  };
}

export class ApiForbidden extends Error {
  constructor() { super("forbidden"); this.name = "ApiForbidden"; }
}
export type Api = ReturnType<typeof createApi>;
