/**
 * The ONE place that says who may do what. Server actions (via `requireRole(rolesFor(...))`) and the UI (via `can(...)`) both read
 * this matrix, so a button is never shown that the server would refuse, and the matrix itself is checked against the database's
 * Row Level Security in tests/integration/rls-matrix.test.ts. The database remains the final enforcer: hiding a control is never security.
 */
export type Role = "owner" | "stock_manager" | "viewer";
export const ROLES: readonly Role[] = ["owner", "stock_manager", "viewer"];

export const CAPABILITIES = {
  /** Products, variants, prices, categories, packaging, catalog import. */
  "catalog.write": ["owner"],
  /** Morning counts and stock movements (record, reverse, repack). */
  "inventory.write": ["owner", "stock_manager"],
  /** Ask for a historical count to be corrected. */
  "corrections.request": ["owner", "stock_manager"],
  /** Approve or reject (and apply) historical corrections. */
  "corrections.decide": ["owner"],
  /** Invite people, change roles, suspend and reactivate members. */
  "team.manage": ["owner"],
  /** Shop name, timezone, valuation policy. */
  "settings.write": ["owner"],
  /** Data health checks, repair of stored sales, full-data backup download. */
  "data.manage": ["owner"],
  /** Read the audit log. */
  "audit.read": ["owner"],
  /** Read dashboards, analytics, history, reports. */
  "data.read": ["owner", "stock_manager", "viewer"],
  /** Export and print reports (read access). */
  "reports.export": ["owner", "stock_manager", "viewer"],
} as const satisfies Record<string, readonly Role[]>;

export type Capability = keyof typeof CAPABILITIES;

export function can(role: Role | null | undefined, capability: Capability): boolean {
  return !!role && (CAPABILITIES[capability] as readonly Role[]).includes(role);
}

export const rolesFor = (capability: Capability): Role[] => [...CAPABILITIES[capability]];

export const ROLE_RANK: Record<Role, number> = { viewer: 0, stock_manager: 1, owner: 2 };
