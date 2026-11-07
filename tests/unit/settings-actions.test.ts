// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const revalidate = vi.fn();
vi.mock("next/cache", () => ({ revalidatePath: (...a: unknown[]) => revalidate(...a) }));
const cookieSet = vi.fn();
vi.mock("next/headers", () => ({
  cookies: async () => ({ set: (...a: unknown[]) => cookieSet(...a), get: () => undefined }),
  headers: async () => ({ get: (k: string) => (k === "host" ? "stokia.test" : null) }),
}));

/* ---- a chainable fake of the supabase client used by the actions ---- */
const rpc = vi.fn();
const calls: { table: string; op: string; args: unknown[] }[] = [];
let result: { data: unknown; error: unknown } = { data: [{ id: "x" }], error: null };
let variantRow: unknown = null;
const fakeSupabase = {
  rpc: (...a: unknown[]) => rpc(...a),
  auth: { updateUser: vi.fn(), signOut: vi.fn() },
  from(table: string) {
    const chain: Record<string, unknown> = {};
    const rec = (op: string) => (...args: unknown[]) => { calls.push({ table, op, args }); return chain; };
    for (const m of ["select", "eq", "update", "insert", "delete", "neq"]) chain[m] = rec(m);
    chain.maybeSingle = async () => (table === "product_variants" ? { data: variantRow, error: null } : result);
    chain.then = (res: (v: unknown) => unknown) => Promise.resolve(result).then(res);
    return chain;
  },
};
const guard = vi.fn();
vi.mock("@/server/services/guard", () => ({ requireRole: (...a: unknown[]) => guard(...a) }));
const sessionCtx = vi.fn();
vi.mock("@/server/services/session", () => ({ getSessionContext: () => sessionCtx() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => fakeSupabase }));

/* ---- the admin client (service role) ---- */
const adminRpc = vi.fn();
const adminInvite = vi.fn();
let adminMemberships: { shop_id: string; status: string }[] = [];
const adminClient = {
  rpc: (...a: unknown[]) => adminRpc(...a),
  from: () => ({ select: () => ({ eq: async () => ({ data: adminMemberships, error: null }) }) }),
  auth: { admin: { inviteUserByEmail: (...a: unknown[]) => adminInvite(...a) } },
};
let adminAvailable = true;
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => (adminAvailable ? adminClient : null), adminConfigured: () => adminAvailable }));

import { cancelCorrectionAction, decideCorrectionAction, requestCorrectionAction } from "@/server/actions/corrections";
import { cancelInvitationAction, changeRoleAction, inviteMemberAction, resendInviteAction, setMemberStatusAction } from "@/server/actions/team";
import { changePasswordAction, signOutOtherDevicesAction, updateProfileAction, updateShopAction } from "@/server/actions/settings";

const SHOP = "11111111-1111-4111-8111-111111111111";
const SESSION = "22222222-2222-4222-8222-222222222222";
const VARIANT = "00000000-0000-4000-8000-000000000001";
const BUNDLE = "00000000-0000-4000-8000-0000000000b1";
const fd = (o: Record<string, string>) => { const f = new FormData(); for (const [k, v] of Object.entries(o)) f.set(k, v); return f; };
const allow = (role = "owner") => guard.mockResolvedValue({ ok: true, userId: "u1", shopId: SHOP, role, supabase: fakeSupabase });

beforeEach(() => {
  rpc.mockReset().mockResolvedValue({ data: { id: "c1", applied: false }, error: null });
  guard.mockReset(); allow();
  calls.length = 0; revalidate.mockReset(); cookieSet.mockReset();
  result = { data: [{ id: "x" }], error: null };
  variantRow = { base_inventory_unit: "packet", packaging_units: [{ id: BUNDLE, variant_id: VARIANT, name: "Bundle", parent_unit_id: null, conversion_factor: "12", base_unit_multiplier: "12", is_active: true }] };
  adminAvailable = true; adminMemberships = []; adminRpc.mockReset().mockResolvedValue({ data: null }); adminInvite.mockReset().mockResolvedValue({ data: { user: { id: "new-user" } }, error: null });
  sessionCtx.mockReset().mockResolvedValue({ user: { id: "u1" }, membership: { shopId: SHOP, role: "owner" } });
});

describe("requestCorrectionAction", () => {
  const call = (o: Record<string, string> = {}) => requestCorrectionAction(SESSION, VARIANT, {}, fd({ reason: "Counted the wrong shelf", [`q:${BUNDLE}`]: "7", "q:base": "5", ...o }));

  it("recomputes the quantity on the server from stored packaging (7 bundles + 5 loose = 89) and records how it was entered", async () => {
    await call();
    const [name, args] = rpc.mock.calls[0];
    expect(name).toBe("request_count_correction");
    expect(args).toMatchObject({ p_session: SESSION, p_variant: VARIANT, p_new_qty: 89, p_reason: "Counted the wrong shelf" });
    expect(args.p_details.entries).toEqual([{ unit_id: BUNDLE, unit_name: "Bundle", quantity: "7", multiplier: "12" }, { unit_id: null, unit_name: "packet", quantity: "5", multiplier: "1" }]);
  });

  it("reports whether it was applied at once (owner) or sent for approval (stock manager)", async () => {
    rpc.mockResolvedValue({ data: { id: "c1", applied: true }, error: null });
    expect(await call()).toEqual({ success: "cor.applied" });
    rpc.mockResolvedValue({ data: { id: "c1", applied: false }, error: null });
    expect(await call()).toEqual({ success: "cor.requested" });
  });

  it("revalidates every screen the correction changes (history, reports, analytics, dashboard)", async () => {
    await call();
    const paths = revalidate.mock.calls.map((c) => c[0]);
    for (const p of ["/settings/corrections", "/dashboard", "/analytics", "/reports", "/stock-history", `/stock-history/${SESSION}`]) expect(paths).toContain(p);
  });

  it("needs a reason and a real quantity (blank is not zero); rejects fractional bundles", async () => {
    expect(await call({ reason: "" })).toMatchObject({ fieldErrors: { reason: "cor.err.reason" } });
    expect(await call({ [`q:${BUNDLE}`]: "", "q:base": "" })).toMatchObject({ fieldErrors: { quantity: "cor.err.quantity" } });
    expect(await call({ [`q:${BUNDLE}`]: "2.5" })).toMatchObject({ fieldErrors: { quantity: "pk.err.fractional_package" } });
    expect(await call({ [`q:${BUNDLE}`]: "", "q:base": "0" })).toEqual({ success: "cor.requested" }); // an explicit zero is a valid correction
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it("ignores units that do not belong to the variant", async () => {
    expect(await call({ "q:00000000-0000-4000-8000-0000000000ee": "3" })).toMatchObject({ fieldErrors: { quantity: "pk.err.unknown_unit" } });
  });

  it("maps database refusals to friendly messages", async () => {
    for (const [msg, key] of [["NO_CHANGE", "cor.err.NO_CHANGE"], ["ALREADY_PENDING", "cor.err.ALREADY_PENDING"], ["NOT_CONFIRMED", "cor.err.NOT_CONFIRMED"], ["FORBIDDEN", "error.forbidden"], ["boom: select * from secrets", "auth.error.generic"]] as const) {
      rpc.mockResolvedValueOnce({ data: null, error: { message: msg } });
      expect(await call()).toEqual({ error: key });
    }
  });

  it("is denied without the capability and for a variant outside the shop", async () => {
    guard.mockResolvedValue({ ok: false, error: "error.forbidden" });
    expect(await call()).toEqual({ error: "error.forbidden" });
    allow(); variantRow = null;
    expect(await call()).toEqual({ error: "cor.err.INVALID_VARIANT" });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("only asks the permission matrix's roles (owner + stock manager) to request", async () => {
    await call();
    expect(guard.mock.calls[0][0]).toEqual(["owner", "stock_manager"]);
  });
});

describe("decide / cancel corrections", () => {
  it("approving calls the database with the note; only owners may decide", async () => {
    expect(await decideCorrectionAction("c1", true, {}, fd({ note: "Looks right" }))).toEqual({ success: "cor.approved" });
    expect(rpc).toHaveBeenCalledWith("decide_count_correction", { p_id: "c1", p_approve: true, p_note: "Looks right" });
    expect(guard.mock.calls[0][0]).toEqual(["owner"]);
  });
  it("rejecting without a note is refused with a field error", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: "NOTE_REQUIRED" } });
    expect(await decideCorrectionAction("c1", false, {}, fd({ note: "" }))).toMatchObject({ error: "cor.err.NOTE_REQUIRED", fieldErrors: { note: "cor.err.NOTE_REQUIRED" } });
  });
  it("a stale request is explained", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: "STALE_CORRECTION" } });
    expect(await decideCorrectionAction("c1", true, {}, fd({}))).toEqual({ error: "cor.err.STALE_CORRECTION" });
  });
  it("cancel goes through the database function", async () => {
    expect(await cancelCorrectionAction("c1", {})).toEqual({ success: "cor.cancelled" });
    expect(rpc).toHaveBeenCalledWith("cancel_count_correction", { p_id: "c1" });
  });
});

describe("inviteMemberAction", () => {
  const call = (o: Record<string, string> = {}) => inviteMemberAction({}, fd({ email: " New.Person@Shop.LK ", display_name: "Nimal", role: "stock_manager", ...o }));

  it("invites a new person by email (normalised), then adds their membership AS THE SIGNED-IN OWNER (RLS applies)", async () => {
    expect(await call()).toEqual({ success: "team.invited" });
    expect(adminInvite).toHaveBeenCalledWith("new.person@shop.lk", expect.objectContaining({ data: { display_name: "Nimal" }, redirectTo: "http://stokia.test/auth/callback?next=/update-password" }));
    const insert = calls.find((c) => c.table === "shop_memberships" && c.op === "insert")!;
    expect(insert.args[0]).toEqual({ shop_id: SHOP, user_id: "new-user", role: "stock_manager", status: "invited" });
  });

  it("without the server key it explains what is missing and does nothing", async () => {
    adminAvailable = false;
    expect(await call()).toEqual({ error: "team.err.noServiceKey" });
    expect(adminInvite).not.toHaveBeenCalled();
  });

  it("an existing account without a shop is simply added (no email is sent)", async () => {
    adminRpc.mockResolvedValue({ data: "existing-user" });
    adminMemberships = [];
    expect(await call()).toEqual({ success: "team.invitedExisting" });
    expect(adminInvite).not.toHaveBeenCalled();
    expect(calls.find((c) => c.op === "insert")!.args[0]).toMatchObject({ user_id: "existing-user", status: "invited" });
  });

  it("refuses someone already in this shop, or who belongs to another shop (one shop per account)", async () => {
    adminRpc.mockResolvedValue({ data: "existing-user" });
    adminMemberships = [{ shop_id: SHOP, status: "active" }];
    expect(await call()).toEqual({ error: "team.err.alreadyMember" });
    adminMemberships = [{ shop_id: "some-other-shop", status: "active" }];
    expect(await call()).toEqual({ error: "team.err.otherShop" });
    expect(calls.some((c) => c.op === "insert")).toBe(false);
  });

  it("validates input before touching anything", async () => {
    expect(await call({ email: "not-an-email" })).toMatchObject({ fieldErrors: { email: "auth.error.email" } });
    expect(await call({ role: "superadmin" })).toMatchObject({ fieldErrors: { role: "team.err.role" } });
    expect(adminRpc).not.toHaveBeenCalled();
  });

  it("surfaces invitation failures and rate limits without leaking details", async () => {
    adminInvite.mockResolvedValueOnce({ data: { user: null }, error: { status: 429, message: "rate limit exceeded for secret-project" } });
    expect(await call()).toEqual({ error: "auth.error.rateLimit" });
    adminInvite.mockResolvedValueOnce({ data: { user: null }, error: { status: 500, message: "smtp password wrong" } });
    expect(await call()).toEqual({ error: "team.err.inviteFailed" });
  });

  it("only owners may invite (team.manage)", async () => {
    await call();
    expect(guard.mock.calls[0][0]).toEqual(["owner"]);
    guard.mockResolvedValue({ ok: false, error: "error.forbidden" });
    expect(await call()).toEqual({ error: "error.forbidden" });
  });

  it("resending an invitation uses the admin API and the same redirect", async () => {
    expect(await resendInviteAction("a@b.lk", {})).toEqual({ success: "team.resent" });
    expect(adminInvite).toHaveBeenCalledWith("a@b.lk", { redirectTo: "http://stokia.test/auth/callback?next=/update-password" });
  });
});

describe("role / status / invitation management", () => {
  it("changing a role goes through RLS and reports the last-owner rule in plain words", async () => {
    expect(await changeRoleAction("m1", {}, fd({ role: "viewer" }))).toEqual({ success: "common.saved" });
    expect(calls.find((c) => c.op === "update")!.args[0]).toEqual({ role: "viewer" });
    result = { data: null, error: { message: "LAST_OWNER" } };
    expect(await changeRoleAction("m1", {}, fd({ role: "viewer" }))).toEqual({ error: "team.err.lastOwner" });
    expect(await changeRoleAction("m1", {}, fd({ role: "boss" }))).toEqual({ error: "team.err.role" });
  });
  it("an update that touched no row (RLS filtered it) is reported as forbidden, not as success", async () => {
    result = { data: [], error: null };
    expect(await changeRoleAction("m1", {}, fd({ role: "viewer" }))).toEqual({ error: "error.forbidden" });
    expect(await setMemberStatusAction("m1", "suspended", {})).toEqual({ error: "error.forbidden" });
  });
  it("suspending and reactivating", async () => {
    result = { data: [{ id: "m1" }], error: null };
    expect(await setMemberStatusAction("m1", "suspended", {})).toEqual({ success: "team.suspended" });
    expect(await setMemberStatusAction("m1", "active", {})).toEqual({ success: "team.reactivated" });
    expect(await setMemberStatusAction("m1", "deleted" as never, {})).toEqual({ error: "auth.error.generic" });
  });
  it("only un-accepted invitations can be cancelled", async () => {
    expect(await cancelInvitationAction("m1", {})).toEqual({ success: "team.invitationCancelled" });
    expect(calls.map((c) => `${c.op}:${JSON.stringify(c.args)}`)).toContain('eq:["status","invited"]');
    result = { data: [], error: null };
    expect(await cancelInvitationAction("m1", {})).toEqual({ error: "team.err.notInvited" });
  });
});

describe("shop settings, profile, password", () => {
  const shop = (o: Record<string, string> = {}) => updateShopAction({}, fd({ name: "Perera & Sons", timezone: "Asia/Colombo", valuation_policy: "cost_at_count", ...o }));

  it("updates name, timezone and the valuation policy (as settings JSON) and refreshes dependent screens", async () => {
    expect(await shop({ valuation_policy: "latest_cost" })).toEqual({ success: "common.saved" });
    expect(calls.find((c) => c.op === "update")!.args[0]).toEqual({ name: "Perera & Sons", timezone: "Asia/Colombo", settings: { valuation_policy: "latest_cost" } });
    expect(revalidate.mock.calls.map((c) => c[0])).toEqual(expect.arrayContaining(["/settings/shop", "/dashboard", "/reports", "/analytics"]));
  });
  it("validates: name length, timezone existence, policy value", async () => {
    expect(await shop({ name: "A" })).toMatchObject({ fieldErrors: { name: "setup.error.name" } });
    expect(await shop({ timezone: "Mars/Base" })).toMatchObject({ fieldErrors: { timezone: "set.err.timezone" } });
    expect(await shop({ valuation_policy: "whatever" })).toMatchObject({ fieldErrors: { valuation_policy: "set.err.policy" } });
    expect(calls.some((c) => c.op === "update")).toBe(false);
  });
  it("explains the timezone lock", async () => {
    result = { data: null, error: { message: "TIMEZONE_LOCKED" } };
    expect(await shop({ timezone: "Asia/Kolkata" })).toMatchObject({ fieldErrors: { timezone: "set.err.timezoneLocked" } });
  });
  it("a non-owner (update touches no row) is told so", async () => {
    result = { data: [], error: null };
    expect(await shop()).toEqual({ error: "error.forbidden" });
  });
  it("only owners may change settings", async () => {
    await shop();
    expect(guard.mock.calls[0][0]).toEqual(["owner"]);
  });

  it("profile: saves name + language for the signed-in user only, and remembers the language on this device", async () => {
    expect(await updateProfileAction({}, fd({ display_name: "Kamala", preferred_language: "si" }))).toEqual({ success: "common.saved" });
    expect(calls.find((c) => c.op === "eq")!.args).toEqual(["id", "u1"]);
    expect(cookieSet).toHaveBeenCalledWith("stokia-locale", "si", expect.objectContaining({ path: "/", sameSite: "lax" }));
    expect(await updateProfileAction({}, fd({ display_name: "", preferred_language: "si" }))).toMatchObject({ fieldErrors: { display_name: "prof.err.name" } });
    expect(await updateProfileAction({}, fd({ display_name: "K", preferred_language: "fr" }))).toMatchObject({ fieldErrors: { preferred_language: "prof.err.language" } });
  });
  it("profile and password require a signed-in user", async () => {
    sessionCtx.mockResolvedValue({ user: null, membership: null });
    expect(await updateProfileAction({}, fd({ display_name: "K", preferred_language: "en" }))).toEqual({ error: "auth.error.notSignedIn" });
    expect(await changePasswordAction({}, fd({ password: "longenough1", confirm: "longenough1" }))).toEqual({ error: "auth.error.notSignedIn" });
    expect(await signOutOtherDevicesAction({})).toEqual({ error: "auth.error.notSignedIn" });
  });
  it("password: 10+ characters and a matching confirmation; sign-out-others keeps this session", async () => {
    expect(await changePasswordAction({}, fd({ password: "short", confirm: "short" }))).toMatchObject({ fieldErrors: { password: "auth.error.passwordShort" } });
    expect(await changePasswordAction({}, fd({ password: "longenough1", confirm: "different11" }))).toMatchObject({ fieldErrors: { confirm: "auth.error.passwordMismatch" } });
    fakeSupabase.auth.updateUser.mockResolvedValue({ error: null });
    expect(await changePasswordAction({}, fd({ password: "longenough1", confirm: "longenough1" }))).toEqual({ success: "prof.passwordChanged" });
    fakeSupabase.auth.signOut.mockResolvedValue({ error: null });
    expect(await signOutOtherDevicesAction({})).toEqual({ success: "prof.signedOutOthers" });
    expect(fakeSupabase.auth.signOut).toHaveBeenCalledWith({ scope: "others" });
  });
});
