import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { MorningStockCalculator } from "@/components/marketing/calculator";
import { I18nProvider } from "@/providers/i18n-provider";

const setup = () => render(<I18nProvider locale="en"><MorningStockCalculator /></I18nProvider>);

describe("landing calculator", () => {
  it("shows 28 units / Rs. 4,200.00 for the default example", () => {
    setup();
    expect(screen.getByText("28")).toBeInTheDocument();
    expect(screen.getByText(/4,200\.00/)).toBeInTheDocument();
  });
  it("blank closing count is pending, not zero", async () => {
    setup();
    await userEvent.clear(screen.getByLabelText("Today morning count"));
    expect(screen.getByText(/Enter today's count/)).toBeInTheDocument();
  });
  it("unexplained increase needs review", async () => {
    setup();
    await userEvent.clear(screen.getByLabelText("Today morning count"));
    await userEvent.type(screen.getByLabelText("Today morning count"), "150");
    expect(screen.getByText(/Needs review/)).toBeInTheDocument();
  });
  it("ignores non-numeric typing", async () => {
    setup();
    await userEvent.type(screen.getByLabelText("Received during the day"), "abc");
    expect(screen.getByLabelText("Received during the day")).toHaveValue("");
  });
});
