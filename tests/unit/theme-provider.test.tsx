import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ThemeToggle } from "@/components/shared/theme-toggle";
import { I18nProvider } from "@/providers/i18n-provider";
import { THEME_SCRIPT, ThemeProvider } from "@/providers/theme-provider";

let prefersDark = false;
// Node 25 ships its own experimental `localStorage` that shadows jsdom's; use a plain in-memory one so the test is the same everywhere.
const store = new Map<string, string>();
const memoryStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k), clear: () => store.clear() };
beforeEach(() => {
  vi.restoreAllMocks();
  vi.stubGlobal("localStorage", memoryStorage);
  store.clear();
  document.documentElement.className = "";
  prefersDark = false;
  window.matchMedia = vi.fn().mockImplementation((q: string) => ({
    matches: q.includes("dark") ? prefersDark : false, media: q, addEventListener: vi.fn(), removeEventListener: vi.fn(),
  })) as unknown as typeof window.matchMedia;
});

const ui = () => render(<I18nProvider locale="en"><ThemeProvider><ThemeToggle /></ThemeProvider></I18nProvider>);

describe("theme provider", () => {
  it("renders no <script> element (the cause of the React 19 console error)", () => {
    const { container } = ui();
    expect(container.querySelector("script")).toBeNull();
  });

  it("follows the device when nothing is saved", async () => {
    prefersDark = true;
    ui();
    await act(async () => {});
    expect(document.documentElement).toHaveClass("dark");
    expect(document.documentElement.style.colorScheme).toBe("dark");
  });

  it("toggles, applies the class, and remembers the choice", async () => {
    ui();
    await act(async () => {});
    expect(document.documentElement).not.toHaveClass("dark");
    await userEvent.click(screen.getByRole("button", { name: /Theme/ }));
    expect(document.documentElement).toHaveClass("dark");
    expect(localStorage.getItem("theme")).toBe("dark");
    await userEvent.click(screen.getByRole("button", { name: /Theme/ }));
    expect(document.documentElement).not.toHaveClass("dark");
    expect(localStorage.getItem("theme")).toBe("light");
  });

  it("a saved choice beats the device setting", async () => {
    prefersDark = true;
    localStorage.setItem("theme", "light");
    ui();
    await act(async () => {});
    expect(document.documentElement).not.toHaveClass("dark");
  });

  it("still works when storage is blocked", async () => {
    vi.spyOn(memoryStorage, "getItem").mockImplementation(() => { throw new Error("blocked"); });
    vi.spyOn(memoryStorage, "setItem").mockImplementation(() => { throw new Error("blocked"); });
    ui();
    await userEvent.click(screen.getByRole("button", { name: /Theme/ }));
    expect(document.documentElement).toHaveClass("dark");
    vi.restoreAllMocks();
  });

  it("the no-flash script applies the saved or device theme before React runs, and never throws", () => {
    localStorage.setItem("theme", "dark");
    new Function(THEME_SCRIPT)();
    expect(document.documentElement).toHaveClass("dark");
    localStorage.setItem("theme", "light");
    prefersDark = true;
    new Function(THEME_SCRIPT)();
    expect(document.documentElement).not.toHaveClass("dark");
    vi.spyOn(memoryStorage, "getItem").mockImplementation(() => { throw new Error("blocked"); });
    expect(() => new Function(THEME_SCRIPT)()).not.toThrow();
    vi.restoreAllMocks();
  });
});
