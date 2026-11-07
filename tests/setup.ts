import "@testing-library/jest-dom/vitest";
import { cleanup, configure } from "@testing-library/react";
import { afterEach, vi } from "vitest";

// waitFor/findBy give up after 1 s by default. With ~60 test files running in parallel that is too tight for the UI tests that wait on
// an async queue (they passed alone but failed intermittently in the full run), so wait up to 5 s. A real failure still fails, just later.
configure({ asyncUtilTimeout: 5000 });

// Vitest globals are off, so RTL's automatic cleanup is not registered. Without this,
// renders from earlier tests leak into later ones.
afterEach(() => cleanup());

// The optional sales-breakdown panel (inside the morning-stock success screen) calls server actions, which import server-only code that
// cannot load in the test browser. Screens that merely CONTAIN the panel get inert stand-ins; the panel's own tests replace them.
vi.mock("@/server/actions/sales-breakdown", () => ({
  loadBreakdownDayAction: vi.fn().mockResolvedValue({ ok: true, day: { date: "", items: [], unavailable: 0 }, canWrite: true }),
  saveBreakdownAction: vi.fn(), clearBreakdownAction: vi.fn(), loadBreakdownHistoryAction: vi.fn().mockResolvedValue({ ok: true, history: [] }),
}));
