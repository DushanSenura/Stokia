import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { ConversionPreview } from "@/components/packaging/conversion-preview";
import type { PackUnit } from "@/lib/calculations/packaging";
import { I18nProvider } from "@/providers/i18n-provider";

const units: PackUnit[] = [{ id: "b", name: "Bundle", parentId: null, factor: 12 }];
const setup = (u = units) => render(<I18nProvider locale="en"><ConversionPreview units={u} baseUnit="packet" /></I18nProvider>);

describe("ConversionPreview (same engine as stock entry)", () => {
  it("7 bundles + 5 loose = 89 packets", async () => {
    setup();
    await userEvent.type(screen.getByLabelText("Bundle"), "7");
    await userEvent.type(screen.getByLabelText("Loose packet"), "5");
    expect(screen.getByText("89")).toBeInTheDocument();
  });
  it("blank is not counted as zero", () => {
    setup();
    expect(screen.getByText(/A blank is not counted as zero/)).toBeInTheDocument();
  });
  it("explicit zero is a real count", async () => {
    setup();
    await userEvent.type(screen.getByLabelText("Bundle"), "0");
    expect(screen.getByText("0", { selector: "p.num" })).toBeInTheDocument();
  });
  it("rejects fractional bundles", async () => {
    setup();
    await userEvent.type(screen.getByLabelText("Bundle"), "2.5");
    expect(screen.getByRole("alert")).toHaveTextContent(/whole bundles/);
  });
  it("converts a total back to bundles + loose", async () => {
    setup();
    await userEvent.type(screen.getByLabelText("Total packet"), "89");
    expect(screen.getByText("7 Bundle + 5 packet")).toBeInTheDocument();
  });
  it("flags a broken definition instead of computing", () => {
    setup([{ id: "b", name: "Bundle", parentId: null, factor: 0 }]);
    expect(screen.getByRole("alert")).toHaveTextContent(/problem/);
  });
});
