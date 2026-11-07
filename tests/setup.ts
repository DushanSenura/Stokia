import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// Vitest globals are off, so RTL's automatic cleanup is not registered. Without this,
// renders from earlier tests leak into later ones.
afterEach(() => cleanup());
