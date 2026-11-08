import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ProfileForm, ShopSettingsForm } from "@/components/settings/account-forms";
import { CorrectionForm, DecisionButtons } from "@/components/settings/correction-controls";
import { SettingsNav } from "@/components/settings/settings-nav";
import { InviteForm, StatusButton } from "@/components/settings/team-controls";
import type { PackUnit } from "@/lib/calculations/packaging";
import { I18nProvider } from "@/providers/i18n-provider";

vi.mock("next/navigation", () => ({ usePathname: () => "/settings/team", useRouter: () => ({ refresh: vi.fn() }) }));
const request = vi.fn(), decide = vi.fn(), cancel = vi.fn();
vi.mock("@/server/actions/corrections", () => ({
  requestCorrectionAction: (...a: unknown[]) => request(...a), decideCorrectionAction: (...a: unknown[]) => decide(...a), cancelCorrectionAction: (...a: unknown[]) => cancel(...a),
}));
const invite = vi.fn(), setStatus = vi.fn();
vi.mock("@/server/actions/team", () => ({
  inviteMemberAction: (...a: unknown[]) => invite(...a), setMemberStatusAction: (...a: unknown[]) => setStatus(...a),
  changeRoleAction: vi.fn(), resendInviteAction: vi.fn(), cancelInvitationAction: vi.fn(),
}));
const shop = vi.fn(), profile = vi.fn();
vi.mock("@/server/actions/settings", () => ({
  updateShopAction: (...a: unknown[]) => shop(...a), updateProfileAction: (...a: unknown[]) => profile(...a), changePasswordAction: vi.fn(), signOutOtherDevicesAction: vi.fn(),
}));

const wrap = (ui: React.ReactNode, locale: "en" | "si" = "en") => <I18nProvider locale={locale}>{ui}</I18nProvider>;
const units: PackUnit[] = [{ id: "bundle", name: "Bundle", parentId: null, factor: 12 }, { id: "carton", name: "Carton", parentId: "bundle", factor: 4 }];

beforeEach(() => { [request, decide, cancel, invite, setStatus, shop, profile].forEach((m) => m.mockReset().mockResolvedValue({})); });

describe("CorrectionForm", () => {
  const show = (isOwner: boolean) => render(wrap(<CorrectionForm sessionId="s1" variantId="v1" units={units} baseUnit="packet" isOwner={isOwner} idPrefix="t" />));

  it("uses the same bundle + loose entry as counting, largest unit first", () => {
    show(false);
    const labels = screen.getAllByRole("textbox").map((el) => el.getAttribute("name"));
    expect(labels).toEqual(["q:carton", "q:bundle", "q:base", "reason"]);
  });
  it("tells a stock manager an owner must approve, and an owner that it applies at once", () => {
    const { unmount } = show(false);
    expect(screen.getByText(/An owner must approve this before it changes anything/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send for approval" })).toBeInTheDocument();
    unmount();
    show(true);
    expect(screen.getByText(/your correction is applied straight away/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Correct and recalculate" })).toBeInTheDocument();
  });
  it("submits the entered quantities and the reason", async () => {
    request.mockResolvedValue({ success: "cor.requested" });
    show(false);
    await userEvent.type(screen.getByLabelText("Bundle"), "7");
    await userEvent.type(screen.getByLabelText(/Loose packet/), "5");
    await userEvent.type(screen.getByLabelText("Why is it wrong?"), "Wrong shelf");
    await userEvent.click(screen.getByRole("button", { name: "Send for approval" }));
    await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    const fd = request.mock.calls[0][3] as FormData; // bound (sessionId, variantId), then React passes (previousState, formData)
    expect(Object.fromEntries(fd.entries())).toMatchObject({ "q:bundle": "7", "q:base": "5", reason: "Wrong shelf" });
    expect(await screen.findByText("Sent for approval.")).toBeInTheDocument();
  });
  it("shows the server's field errors next to the fields", async () => {
    request.mockResolvedValue({ fieldErrors: { quantity: "cor.err.quantity", reason: "cor.err.reason" } });
    show(true);
    await userEvent.click(screen.getByRole("button", { name: "Correct and recalculate" }));
    expect(await screen.findByText(/Enter the correct quantity/)).toBeInTheDocument();
    expect(screen.getByText("Enter a reason.")).toBeInTheDocument();
  });
  it("keeps typed values when validation fails (no wiped form)", async () => {
    request.mockResolvedValue({ fieldErrors: { reason: "cor.err.reason" } });
    show(false);
    await userEvent.type(screen.getByLabelText(/Loose packet/), "9");
    await userEvent.click(screen.getByRole("button", { name: "Send for approval" }));
    await screen.findByText("Enter a reason.");
    expect(screen.getByLabelText(/Loose packet/)).toHaveValue("9");
  });
});

describe("DecisionButtons", () => {
  it("approve and reject are separate actions; reject asks why", async () => {
    decide.mockResolvedValue({ success: "cor.approved" });
    render(wrap(<DecisionButtons correctionId="c1" />));
    await userEvent.click(screen.getByRole("button", { name: "Approve and apply" }));
    await waitFor(() => expect(decide).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("Approved. Affected sales were recalculated.")).toBeInTheDocument();
    expect(screen.getByLabelText("Say why (required when rejecting)")).toBeRequired();
  });
  it("shows the 'say why' error when rejecting without a note", async () => {
    decide.mockResolvedValue({ error: "cor.err.NOTE_REQUIRED", fieldErrors: { note: "cor.err.NOTE_REQUIRED" } });
    render(wrap(<DecisionButtons correctionId="c1" />));
    await userEvent.click(screen.getByRole("button", { name: "Reject" }));
    expect((await screen.findAllByText("Say why you are rejecting it.")).length).toBeGreaterThan(0);
  });
});

describe("InviteForm", () => {
  it("lists the three roles with what each can do, defaulting to the least risky useful one", () => {
    render(wrap(<InviteForm serviceKeyReady />));
    expect(screen.getByLabelText(/Stock manager: enters counts/)).toBeChecked();
    expect(screen.getByLabelText(/Owner: full access/)).not.toBeChecked();
    expect(screen.getByLabelText(/Viewer: can only look/)).not.toBeChecked();
  });
  it("warns when the server key is missing", () => {
    render(wrap(<InviteForm serviceKeyReady={false} />));
    expect(screen.getByText(/needs the server key SUPABASE_SERVICE_ROLE_KEY/)).toBeInTheDocument();
  });
  it("sends email, name and role and clears the form after success", async () => {
    invite.mockResolvedValue({ success: "team.invited" });
    render(wrap(<InviteForm serviceKeyReady />));
    await userEvent.type(screen.getByLabelText("Email"), "new@shop.lk");
    await userEvent.type(screen.getByLabelText("Name (optional)"), "Nimal");
    await userEvent.click(screen.getByLabelText(/Viewer: can only look/));
    await userEvent.click(screen.getByRole("button", { name: "Send invitation" }));
    await waitFor(() => expect(invite).toHaveBeenCalledTimes(1));
    expect(Object.fromEntries((invite.mock.calls[0][1] as FormData).entries())).toEqual({ email: "new@shop.lk", display_name: "Nimal", password: "", role: "viewer" });
    expect(await screen.findByText(/Invitation sent/)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText("Email")).toHaveValue(""));
  });
  it("can also send a password the owner chose, in a hidden password box", async () => {
    invite.mockResolvedValue({ success: "team.createdWithPassword" });
    render(wrap(<InviteForm serviceKeyReady />));
    const box = screen.getByLabelText("Password (optional)");
    expect(box).toHaveAttribute("type", "password");
    await userEvent.type(screen.getByLabelText("Email"), "new@shop.lk");
    await userEvent.type(box, "a-long-password-1");
    await userEvent.click(screen.getByRole("button", { name: "Send invitation" }));
    await waitFor(() => expect(invite).toHaveBeenCalledTimes(1));
    expect((invite.mock.calls[0][1] as FormData).get("password")).toBe("a-long-password-1");
    expect(await screen.findByText(/Account created/)).toBeInTheDocument();
  });
});

describe("StatusButton (suspending a person)", () => {
  it("asks for confirmation first; cancelling does nothing", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    render(wrap(<StatusButton membershipId="m1" to="suspended" name="Kamala" />));
    await userEvent.click(screen.getByRole("button", { name: "Suspend" }));
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("They lose access straight away"));
    expect(setStatus).not.toHaveBeenCalled();
    confirm.mockReturnValue(true);
    await userEvent.click(screen.getByRole("button", { name: "Suspend" }));
    await waitFor(() => expect(setStatus).toHaveBeenCalledTimes(1));
    confirm.mockRestore();
  });
  it("reactivating needs no confirmation", async () => {
    const confirm = vi.spyOn(window, "confirm");
    render(wrap(<StatusButton membershipId="m1" to="active" name="Kamala" />));
    await userEvent.click(screen.getByRole("button", { name: "Reactivate" }));
    await waitFor(() => expect(setStatus).toHaveBeenCalledTimes(1));
    expect(confirm).not.toHaveBeenCalled();
    confirm.mockRestore();
  });
  it("shows why a change failed (e.g. the last owner)", async () => {
    setStatus.mockResolvedValue({ error: "team.err.lastOwner" });
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(wrap(<StatusButton membershipId="m1" to="suspended" name="Owner" />));
    await userEvent.click(screen.getByRole("button", { name: "Suspend" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/at least one active owner/);
  });
});

describe("ShopSettingsForm", () => {
  const show = (locked: boolean) => render(wrap(<ShopSettingsForm name="Perera Stores" timezone="Asia/Colombo" timezones={["Asia/Colombo", "Asia/Kolkata"]} timezoneLocked={locked} policy="cost_at_count" />));
  it("locks the timezone once counts exist, but still submits its current value", async () => {
    show(true);
    expect(screen.getByLabelText("Business timezone")).toBeDisabled();
    expect(screen.getByText(/Changing it would change which day every past count belongs to/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Save shop settings" }));
    await waitFor(() => expect(shop).toHaveBeenCalledTimes(1));
    expect(Object.fromEntries((shop.mock.calls[0][1] as FormData).entries())).toMatchObject({ timezone: "Asia/Colombo", name: "Perera Stores", valuation_policy: "cost_at_count" });
  });
  it("offers the two valuation policies, explains each, and the currency is fixed", () => {
    show(false);
    expect(screen.getByLabelText(/The purchase cost on the day of the count/)).toBeChecked();
    expect(screen.getByText(/Recommended\. A past count keeps the cost it had then/)).toBeInTheDocument();
    expect(screen.getByLabelText(/The latest purchase cost/)).not.toBeChecked();
    expect(screen.getByLabelText("Currency")).toHaveAttribute("readonly");
    expect(screen.getByLabelText("Business timezone")).toBeEnabled();
  });
});

describe("ProfileForm", () => {
  it("offers English and Sinhala (each in its own script) and saves", async () => {
    render(wrap(<ProfileForm displayName="Nimal" language="en" />));
    const select = screen.getByLabelText("Language");
    expect(Array.from((select as HTMLSelectElement).options).map((o) => o.text)).toEqual(["English", "සිංහල"]);
    await userEvent.selectOptions(select, "si");
    await userEvent.click(screen.getByRole("button", { name: "Save profile" }));
    await waitFor(() => expect(profile).toHaveBeenCalledTimes(1));
    expect(Object.fromEntries((profile.mock.calls[0][1] as FormData).entries())).toEqual({ display_name: "Nimal", preferred_language: "si" });
  });
});

describe("SettingsNav", () => {
  it("marks the current section and shows the audit log only to people who may read it", () => {
    const { rerender } = render(wrap(<SettingsNav canAudit={false} />));
    expect(screen.getByRole("link", { name: "Team" })).toHaveAttribute("aria-current", "page");
    expect(screen.queryByRole("link", { name: "Audit log" })).not.toBeInTheDocument();
    rerender(wrap(<SettingsNav canAudit />));
    expect(screen.getByRole("link", { name: "Audit log" })).toHaveAttribute("href", "/settings/audit");
  });
});
