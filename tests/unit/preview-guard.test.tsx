// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined }) }));

import DashboardPreview from "@/app/preview/dashboard/page";

describe("demo preview route", () => {
  afterEach(() => { delete process.env.STOKIA_PREVIEW; });
  it("is a 404 unless STOKIA_PREVIEW=1 (so it can never be reached in production)", async () => {
    delete process.env.STOKIA_PREVIEW;
    await expect(DashboardPreview({ searchParams: Promise.resolve({}) } as never)).rejects.toThrow(/NEXT_HTTP_ERROR_FALLBACK;404|NEXT_NOT_FOUND/);
  });
  it("renders when the flag is set", async () => {
    process.env.STOKIA_PREVIEW = "1";
    await expect(DashboardPreview({ searchParams: Promise.resolve({}) } as never)).resolves.toBeTruthy();
  });
});
