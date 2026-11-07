import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import * as web from "@/lib/offline/sync-queue";
import { defineQueueSuite } from "./helpers/queue-suite";

// The rules themselves are asserted once, in the shared suite, against every storage backend. This file runs them over the
// web app's IndexedDB binding; sqlite-queue-store.test.ts runs the same suite over the phone's SQLite binding.
defineQueueSuite("web (IndexedDB)", () => web);

describe("web binding only", () => {
  it("reports 'unavailable' (rather than pretending) when the device cannot store anything", async () => {
    const real = globalThis.indexedDB;
    // @ts-expect-error simulate a blocked/unsupported browser
    delete globalThis.indexedDB;
    try {
      expect(await web.enqueueCount({
        scope: "shop1:user1", businessDate: "2026-11-02", ack: true, key: "key-0123456789",
        payload: { businessDate: "2026-11-02", revision: null, items: [] }, labels: {}, yours: {},
      })).toEqual({ ok: false, reason: "unavailable" });
    } finally { globalThis.indexedDB = real; }
  });
});
