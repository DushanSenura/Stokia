# Architecture (Phase 1)

## Layers
`app/` routes (thin) → `server/actions` & `server/services` (auth + business flow) → Supabase (RLS enforces access).
Pure domain logic lives in `lib/calculations` (no UI/DB imports). i18n in `src/i18n` (English source, Sinhala partial with fallback).

## Security model
- Invitation-only accounts (public sign-up disabled in Supabase).
- `src/proxy.ts` (Next 16 successor to middleware) refreshes sessions and redirects anonymous users; the dashboard layout re-checks
  on the server; **RLS is the real boundary** (`supabase/migrations/…_rls_and_functions.sql`).
- Roles: owner (full), stock_manager (draft counts, movements), viewer (read). Movements and audit logs are append-only for clients;
  `daily_sales`, corrections and audit are written only by SECURITY DEFINER functions (Phase 4/5).
- Only the public anon key reaches the browser. Redirect targets are validated (`safeNextPath`).

## Database notes
Quantities `numeric(18,3)`, money `numeric(14,2)`. `stock_count_lines` constraint makes "not counted" = NULL and forbids zero-by-default.
`stock_count_sessions.business_date` is the *count* morning; `daily_sales.sales_date` is the *sales* day (count date − 1). Price history has an
exclusion constraint against overlapping periods. Referenced rows use `on delete restrict` / `is_active` (no hard deletes).

## Assumptions
- One shop per user in V1 (`create_shop` refuses if a membership exists); schema supports more.
- Sinhala strings need native-speaker review. `cacheComponents` is off (everything is per-user dynamic).
- Next.js 16: `proxy.ts`, async `cookies()`/`searchParams`, `LayoutProps`/`PageProps` helpers.

## Phase 2 — product catalog
- Routes: `/products` (server-side search/filter/sort/pagination, 20 per page), `/products/new`, `/products/[id]` (edit, image, variants, prices),
  `/products/categories`, `/products/import`, `GET /api/exports/products`.
- Writes go through `server/actions/catalog.ts` (owner-only via `requireRole`, zod-validated), and again are enforced by RLS.
- Prices: `set_variant_price()` closes the open period and opens a new one; history can't be rewritten or overlap. `priceAt()` (lib/calculations/pricing.ts)
  picks the price in force on a date, which Phase 5 uses so estimates keep historical prices.
- Import: CSV only, 2 MB / 2000 rows, validated in TypeScript (`features/products/import.ts`) then applied by `import_catalog()` in ONE transaction
  (any conflict rolls back everything). Create-only: existing product codes/SKUs are errors, never overwritten. Exports neutralise spreadsheet formulas.
- Images: Supabase Storage bucket `product-images` (owner-write, path `<shop_id>/…`); type is checked by magic bytes, not the declared MIME.
- A variant's counting unit (`base_inventory_unit`) is fixed after creation, because changing it would reinterpret past counts.
- Forms use `useActionForm` (no auto-reset, so typed values survive validation errors).
- Not yet: Excel (.xlsx) import/export (planned with the report exports, Phase 7), bulk archive.

## Testing the database without Supabase
`tests/integration/*` loads the real migrations into PGlite (in-process Postgres) with stubs for Supabase auth/storage/roles and checks RLS,
shop isolation, constraints, price history and import rollback. It is not a substitute for a smoke test on a real Supabase project.

## Phase 3 — packaging & bundle engine
- **One engine:** `src/lib/calculations/packaging.ts` (`resolveUnits`, `normalizePackagingQuantity`, `denormalizeQuantity`, `describeUnit`,
  `aggregateByBaseUnit`). Morning stock entry, receiving, movements, reports and analytics must call it; nobody re-implements the multiplication.
- **Model:** each variant has an implicit base unit (multiplier 1). A packaging unit is made of `conversion_factor` of the next-smaller unit
  (`parent_unit_id`, NULL = base units). `base_unit_multiplier` is derived by the DB (client values ignored). Max 5 levels, multiplier <= 1,000,000.
- **Counting rules:** packaging units are whole numbers only; the base unit allows up to 3 decimals. A unit may appear once per count (no double
  counting). If every field is blank the product is *not counted* (never zero); if any field is filled, blank siblings count as 0.
- **Defence in depth:** the TS engine gives friendly field errors; the `packaging_units_guard` trigger enforces the same rules in Postgres
  (cycles, same-variant parents, depth, positive factor, name clashes, derived multipliers, cascade recompute).
- **History safety:** a unit used by a stock movement cannot change size or parent (`PACKAGING_IN_USE`); deactivate it and add a new one.
  Units are never hard-deleted. Phase 4 must snapshot the multipliers into `stock_count_lines.entry_details` so old counts stay explainable.
- **Out of scope (by design):** mixed-product kits/BOM. Packaging is same-variant only; the UI says so. Repacking (converting stock between
  sizes) arrives with Phase 5 movements.
- **Routes:** `/packaging` (searchable list with conversions), `/packaging/[variantId]` (units, edit, deactivate, live conversion preview).

## Phase 4 — morning stock entry
- **Dates:** a count on date D calculates sales of D-1 (`salesDateFor`). Business dates are `YYYY-MM-DD` strings in the shop timezone (never JS local dates).
  The price used for a sales date is the one in force at noon shop-time on that date (documented, deterministic), not the latest price.
- **Flow:** `/morning-stock` loads active variants + packaging + previous confirmed count; the client previews totals with `features/inventory/count-entry.ts`;
  autosave (1.5 s debounce, serialised) -> `save_count_draft`; Review -> `confirm_count`. The server RECOMPUTES every total from stored packaging
  (`server/actions/inventory.ts`) and snapshots multipliers into `entry_details`; the browser's totals are only a preview.
- **DB functions (SECURITY DEFINER, role-checked):** `save_count_draft` (optimistic `revision`, replaces the line set, rejects future dates / out-of-order / other-shop
  variants), `confirm_count` (row lock; idempotent; requires acknowledgement for uncounted products; writes explicit `not_counted` NULL lines; audited),
  `discard_count_draft`. Direct client writes to count tables are revoked, so a confirmed count is immutable to API clients.
- **Blank vs zero:** blank = not counted (no line); `0` = counted zero. Uncounted active products are stored as `not_counted` at confirmation.
- **Skipped days:** if the previous confirmed count is more than one day back, the UI warns that sales for the days between cannot be split. Phase 5 decides how
  they are represented (they must stay pending, never be spread or assumed).
- **Interim figures:** the entry screen shows *preliminary* units/value that ignore deliveries, returns and damage (Stock Movements arrive in Phase 5). An increase is shown
  as Needs Review with no sales value. `daily_sales` is not written until Phase 5.
- **No `revalidatePath('/morning-stock')`** in save/confirm on purpose (it would remount the form mid-typing / replace the success screen).
- **History:** `/stock-history` (date filter, pagination, CSV export), `/stock-history/[id]` (lines, entered-as, previous, change).
- **Not yet:** historical corrections with approval (Phase 8), offline/IndexedDB drafts (Phase 9), multi-device live sync (conflicts are detected, not merged).

## Phase 5 — stock movements & the sales reconciliation engine
**The rule** (`lib/calculations/reconcile.ts` is the specification; SQL `_recalc_sales_day` is the atomic implementation; a randomised parity test compares them):
`units sold(S) = opening(count on S) + Σ signed movements in (counted_at(S), counted_at(S+1)] − closing(count on S+1)`.
- **pending** — closing count missing (`awaiting_next_count`, or `missing_count` if a later count exists, i.e. a day was skipped), or the product was not counted on the
  opening/closing morning. Never defaulted to zero or to "everything sold".
- **needs_review** — negative result (stock rose with nothing recorded). No units, no money.
- **calculated / recalculated** — money = units × the selling price in force at **noon (shop tz) on the sales date**, stored as `price_reference`; a later price change never rewrites history.
- A pending placeholder replaced by the first real figure is revision 1 (no history row). Any later change bumps `calculation_revision`, sets `recalculated`, and the previous
  values + reason go to `daily_sales_revisions`. Unchanged recalculation is a no-op (no churn).
- Only consecutive-day counts form an interval. A skipped morning leaves that day pending permanently (no spreading); the skipped day itself has no rows.
**When movements belong where:** `counted_at` is when counting STARTED (session creation). A delivery before it was physically included in the count, so it is in the interval that count closes;
one after it opens the next. The movement form makes this explicit ("before this morning's count" stamps it 1 minute before counting began). Boundary: (opening, closing].
**Atomicity:** `confirm_count` reconciles inside the same transaction; if reconciliation fails the count is not confirmed. `record_movement`, `record_repacking`, `reverse_movement`
recalculate the one affected interval in the same transaction.
**Movements:** signed effect stored for every type (CHECK per type), append-only, clients cannot insert directly. `idempotency_key` (unique per shop) makes retries safe (same key + same
payload = original returned; same key + different payload = refused). Mistakes are *reversed* (a compensating entry at the original time, once only), never edited or deleted.
Repacking is an explicit atomic pair between two sizes. The server recomputes the effect from stored packaging; the DB re-verifies it.
**Out of scope / known limits:** supporting-document upload for movements; Excel-style closed-day (a shop closed on Sundays must still enter a Sunday count, otherwise Saturday stays pending);
count corrections with approval (Phase 8; it will call `_recalc_range`, already tested by simulating a correction).

## Phase 6 — dashboard & notifications
- **Data:** aggregates are computed in Postgres (`sales_daily_summary`, `sales_top_products`, `stock_valuation`, `low_stock_items`, migration 7), all SECURITY INVOKER so RLS still applies; a covering index keeps
  12-month scans cheap. The dashboard never downloads raw `daily_sales` rows. Pure shaping/rules live in `features/dashboard/summary.ts` (tested); I/O in `server/repositories/dashboard.ts`.
- **What the dashboard may claim:** "Yesterday" is the sales date a count today would calculate. If this morning's count is missing it shows **Pending** (never zero, never an older day's number).
  Money is additive across products; quantities are listed per base unit and never summed across units. A closed month needs the next month's first count; until then it is "waiting for the {date} count".
- **Stock value:** value of the LATEST confirmed count at the purchase cost in force when that count was taken (explicit policy; at cost, not retail; never a sum of several mornings). Products with no cost are counted
  and reported as excluded, so the figure is a floor, not a guess.
- **Low stock:** latest confirmed count `quantity <= threshold` (threshold 0 = alert only at zero stock). Not-counted products are unknown, not low.
- **Date filtering:** month stepper + sales date, in the URL (shareable). The sales date is clamped to yesterday, the month to the current month.
- **Charts** follow the data-viz rules: brand emerald as the single data hue (validated for light and dark, CVD dE 8.6 / 10.3), hatched texture for pending/review/partial days so colour is never the only cue,
  ≤24px bars with 4px rounded data ends, 2px lines, hairline grid, tooltips on hover (value first), click a bar to open the count that explains that day, a legend, and a **table view for every chart**.
  A month still open is drawn as a separate hollow marker, never joined to the line, so a part-month can't look like a collapse.
- **Notifications:** derived, not stored (`/api/notifications` → bell): count owed / draft, skipped mornings, results needing review, low stock, a monthly report waiting for a count.
  The dashboard shows the same list minus the count alerts (the hero card already says it).
- **Demo preview:** `/preview/dashboard` renders the real dashboard with fixed demo data for design review and visual tests. It is a 404 unless `STOKIA_PREVIEW=1` (never set it in production).

## Phase 7 — sales analytics & monthly reports
**Month boundary rule (database, migration 8):** a month's last sales day is calculated by the NEXT month's first count. For a monthly report,
opening stock = the count on the 1st, closing stock = the count on the 1st of the next month (so one month's closing is the next one's opening: continuity),
movements = `counted_at(opening) < effective_at <= counted_at(closing)`. Stock is never summed over mornings. The month is *in progress* (current month),
*pending* (closed on the calendar but the closing count is not confirmed) or *complete*.
**Identity (tested on a full real month):** `opening + received + returns − damaged/lost − supplier returns ± adjustments − closing = units sold` exactly,
whenever every day was calculated. Anything else shows up as **Unreconciled** (the quantity sitting in needs-review/pending days): e.g. an unexplained +30
shows as −25 against the product instead of being hidden.
- **Analytics** (`/analytics`): date range + presets, category, product, size filters (all in the URL); day/week/month bars, 12-month trend, month-over-month
  (like-for-like over the same elapsed days while the month is open), category contribution, best sellers, slow movers (zero-sales included), product-wise and
  size-wise tables, stock-movement trend (inflow up / outflow down, one base unit at a time). Money is added across products; quantities never across units.
  Range ≤ 400 days (enforced in SQL; the UI clamps and says so). Aggregation happens in Postgres; pure shaping in `features/analytics/aggregate.ts`.
- **Reports** (`/reports`, `/reports/[month]`): one model (`features/reports/report.ts`) feeds the on-screen/print view and the PDF/Excel/CSV exports, so every
  output shows the same numbers. Badges: Pending / In progress / Complete, **Recalculated** (any day recomputed after its first calculation) and **Exported**
  (or *Changed since export*, detected by comparing a data-version fingerprint stored with each export in `report_exports`).
- **Exports** (`/api/reports/[month]/[format]`): any member may export (viewers have read access); every export is logged (who, when, format, data version) BEFORE the file is returned — if logging
  fails the file is refused. Branding, shop, title, period, generated time (shop tz), currency and the "inferred / Estimated Sales, not cash; stock at cost" statement are on every format.
  Text cells are guarded against spreadsheet formula injection (`'` prefix; numbers stay numbers). Excel has real numeric cells + number formats; PDF is paginated with page numbers.
- **PDF limitation:** the PDF uses a built-in Latin font, so Sinhala/Tamil letters print as `?` and the report says so; Excel and CSV keep every character. Embedding a Sinhala font is the fix if PDFs with Sinhala names are needed.
- **Print:** `print:` styles hide the app chrome and controls, force black-on-white, repeat table headers; printing is logged like an export.
- **Valuation policy:** closing stock at the purchase cost in force at the closing count; uncosted products are flagged, so the value is a minimum.
- **Preview routes** (`/preview/*`, `STOKIA_PREVIEW=1` only): demo data for visual review and for proving the bundled PDF/Excel/CSV generators work in the production build.

## Phase 8 — security, team, settings, localization

**Permissions.** One matrix in `src/server/permissions/index.ts` (`CAPABILITIES`, `can()`, `rolesFor()`). Server actions call `requireRole(rolesFor(cap))`; the UI hides controls with `can(role, cap)`. The database enforces the same rules independently (RLS plus role checks inside SECURITY DEFINER RPCs), so hiding a button is never the only protection.

| Capability | owner | stock manager | viewer |
|---|---|---|---|
| catalog.write, settings.write, team.manage, audit.read, corrections.decide | yes | – | – |
| inventory.write, corrections.request | yes | yes | – |
| data.read, reports.export | yes | yes | yes |

**Count corrections.** A confirmed count is never edited in place. A stock manager *requests* a correction (new quantity + mandatory reason); an owner *approves or rejects* it (a rejection needs a note). An owner's own request applies immediately. Applying a correction updates the line, marks the session `corrected`, recalculates sales for D-1 and D, and writes audit entries with the previous value. One pending request per line (`corrections_one_pending`). Quantities are recomputed server-side from the stored packaging.

**Team.** Owners invite by e-mail (needs `SUPABASE_SERVICE_ROLE_KEY`, server-only; see `.env.example`), change roles, suspend, and cancel invitations. The last owner cannot be removed or demoted (`LAST_OWNER` trigger). One shop per account. Invited users activate their membership through `accept_invitation()` when they set a password; suspended users land on a notice at `/setup`.

**Shop settings.** Name, timezone and valuation policy (`cost_at_count` default, or `latest_cost`) live in `shops.settings`, validated by the `shops_guard` trigger. The timezone is locked once any non-draft count exists, because moving it would shift which day every historical sale belongs to. The policy changes `stock_valuation` and the monthly report.

**Hardening.** Migration 9 revokes `EXECUTE` on all functions from PUBLIC/anon/authenticated and re-grants an explicit allowlist; default privileges deny new functions. `supabase/tests/rls_verify.sql` returns zero rows when everything holds (RLS enabled, no anon grants, no `using(true)`, no unexpected DEFINER functions, append-only tables protected, every table shop-scoped). It runs in the test suite (`tests/integration/rls-matrix.test.ts`) and can be run in the Supabase SQL editor against a real project.

**Audit.** Owners can filter (action, entity, date) and export the audit log as CSV (`/api/exports/audit`, formula-injection guarded). Secrets are never written to it.

**Localization.** English is the typed source; Sinhala (`si.ts` + `si-core.ts`) covers navigation, sign-in, shop setup, the whole morning-stock flow, dashboard KPIs, movement types, and settings navigation. Other strings fall back to English. **The Sinhala text has not been reviewed by a native speaker and must be before launch.**

**Accessibility.** `tests/e2e/a11y.spec.ts` runs axe (WCAG 2.0/2.1 A and AA, serious and critical) on the landing page, sign-in, reset, and the dashboard, analytics, report and settings previews, in light and dark, desktop and mobile. Fixes made: darker muted text, a dark-mode CTA button, scrollable tables are keyboard-focusable, no dangling `aria-controls`.

## Phase 9 — optimization and data reliability

**Entries survive a bad connection.** While counting, the typed entries are also written (after 300 ms) to this browser's IndexedDB (`src/lib/offline/draft-store.ts`), keyed by shop + user + count date. The server copy still wins: once a save succeeds the device copy is deleted. On the next visit:
- the device copy was made against the same server revision → entries are restored and saved automatically;
- the saved count has moved on since → nothing is overwritten silently; the person chooses "Use this device's entries" or "Keep the saved count";
- identical to the saved count → quietly discarded.

An offline banner appears, counting continues, and a save is attempted the moment the connection returns. Writes are queued in order so a late save can never resurrect a cleared draft; copies expire after 14 days; with IndexedDB unavailable (private window) everything is a silent no-op. Sign-out clears all device copies on a best-effort basis (the navigation can interrupt it), which is why the key also contains the user id and copies expire.

**Data health check** (`data_health_check`, owner only, Settings → Data). Structural checks: confirmed counts with no lines or no confirmer, count lines or movements pointing at another shop's product, sales rows linked to the wrong day's count, calculated sales with no valid figure, confirmed mornings with no sales rows; warnings for active products with no selling price and drafts left for more than 3 days. The most valuable check is *"would a fresh recalculation change any stored figure?"*: it runs the real reconciliation inside a sub-transaction, counts the differences, and rolls everything back, so a check never changes data (tested). Because it uses the same code as production, there is no second implementation to disagree with.

**Repair** (`repair_sales`, owner only). Runs the same reconciliation for real. Counts and movements are never touched; any figure that changes keeps its previous version in `daily_sales_revisions`, and the action is written to the audit log. Idempotent: a second run changes nothing (tested).

**Backup.** `/api/exports/backup` (owner only) streams one JSON file with every table of the shop (15 tables, no e-mail addresses or password material). The file ends with a footer holding row counts and a SHA-256 over every row, so a truncated, edited or damaged file is detected by `verifyBackup`. Each download is audited with its counts and checksum; a download that fails or is cancelled is audited as `incomplete`. **This is a copy for safekeeping, not a restore button.** Restoring is deliberately not self-service because re-inserting rows blindly would bypass the append-only and reconciliation rules; restore from the file is a maintainer task. Hosting-level backups (Supabase daily backups / point-in-time recovery on paid plans) are separate and should be enabled.

**Large catalogs.** Measured against the real migrations in an in-process Postgres with 3,000 products × 14 mornings (42,000 count lines, 42,000 sales rows), all well under 2 s: dashboard functions 80–300 ms, analytics 300–350 ms, saving + confirming a 3,000-line count about 0.5 s together, recalculating one day 45 ms, a 30-day health check about 1.5 s. `tests/integration/performance.test.ts` keeps generous budgets so an accidental O(n²) or a lost index fails the build, and checks with `EXPLAIN` that the hot queries use indexes. In the browser, 3,000 products render a window of 40 cards and a keystroke costs about 65 ms in jsdom. Migration 10 adds the indexes that were missing (count lines by product, movements by shop/time, latest confirmed count per shop, audit by action, price lookup); one index I first added turned out to be redundant with an existing unique key and was removed. These are numbers from an in-process database on a developer laptop, not from Supabase under load: re-measure on the real project.

## Phase 10 — end-to-end, cross-browser, hardening, deployment

**Tests.** `tests/e2e` runs against the production build (`next build` + `next start`) in five setups: Chrome desktop, Pixel 7, Firefox, Safari (WebKit) desktop and iPhone 14. Beyond the earlier smoke tests it now checks: security headers on every response and no framework banner; the health endpoint leaks no key or URL; no console error, uncaught exception, failed request or CSP violation on any public or preview page; no horizontal scroll at 320/390/768/1024/1440 px; Sinhala switching survives a reload; dark theme survives navigation; keyboard Tab order and focus rings on the landing page; the friendly 404; and every data API returns 401 to anonymous callers without a stack trace. Axe accessibility checks run in all five setups.

**What the end-to-end tests cannot do.** They cannot sign in, because there is no Supabase project in the test environment. Signed-in behaviour is covered below the browser instead: server actions with a faked client, components with React Testing Library, and every database function and policy against the real migrations. The gap is the wiring between the two (cookies, the Supabase client against a live API). That is what the first-deploy checks in `docs/deployment.md` exist for.

**Security headers** (production only, `next.config.ts`): CSP limiting network access to this site and the Supabase project, `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy`, `Permissions-Policy` denying camera/microphone/geolocation, `Cross-Origin-Opener-Policy`, HSTS, and no `X-Powered-By`. `'unsafe-inline'` remains for scripts and styles (see deployment guide).

**Health endpoint** `/api/health`: booleans only (Supabase configured, site URL set, invitations available); 503 when a required variable is missing, so a host's health check catches a bad deploy.

**CI** `.github/workflows/ci.yml`: typecheck, lint, unit/database tests, then all browsers.

**Findings from cross-browser runs.** Firefox and WebKit surfaced no layout or behaviour bugs. Three test failures were test problems, fixed in the tests: contrast was being measured mid fade-in animation, charts need a moment to measure their container, and Safari does not Tab to links by default (that check is skipped on WebKit, with the reason in the test).

## Done: all ten phases.


## Phase 11 (part 1): retry-safe, conflict-aware count submission

Why: a phone on a poor connection retries, and two devices can count the same morning. The old confirm was two calls (save, then confirm) and treated "already confirmed" as success.

`submit_count(shop, date, lines, base_revision, key, confirm, ack_missing, device)` (migration `...011`) saves and confirms in **one transaction**:
- **Idempotency.** The client generates a key per distinct request (`src/lib/offline/idempotency.ts`). The server stores the answer in `idempotency_records` (30 days). Same key + same request returns the original answer (`replayed: true`) and applies nothing twice; same key + different data is rejected (`IDEMPOTENCY_KEY_REUSED`). The table has no grants: only the SECURITY DEFINER function touches it.
- **Conflicts never overwrite.** A stale revision, or a day another submission already confirmed, returns `status: "conflict"` with `reason` and the server's current copy (`_count_snapshot`: revision, who, lines) and writes a `count_sync_conflict` audit row. Conflicts are not cached under the key, so a retry re-evaluates.
- **Resolution is explicit and client-side.** "Use mine" resubmits against the server's revision with a NEW key. A confirmed day is never overwritten: it goes through the existing correction-approval flow.
- **Atomic.** If confirming fails (e.g. missing counts not acknowledged) the draft save is rolled back with it.

Verified three ways: 14 database tests on PGlite (`tests/integration/sync-db.test.ts`), the same scenarios run as a signed-in user on a real local Supabase (rolled back), and `rls_verify.sql` returning zero rows there.

Not done yet: the offline queue UI, the conflict-comparison screen, the PWA shell and the native apps. The server contract above is what they will call.


## Phase 11 (part 2): installable app, offline queue, conflict screen

**Installable (PWA).** `src/app/manifest.ts`, icons in `public/icons/` (192, 512, maskable, 180 Apple), `public/sw.js`, `public/offline.html`, `/install` page with Android and iPhone steps, and an "Update now" notice (`pwa-registrar.tsx`).
- The service worker is deliberately small. It caches only fixed app files (`/_next/static`, icons, logo) and shows `offline.html` when a page navigation gets no connection. It never touches `/api/`, other origins (Supabase), non-GET requests, Next.js data requests, or page navigations, so no signed-in data is ever stored. `tests/unit/service-worker.test.ts` runs the real file in a sandbox to prove each refusal.
- An update waits until the person taps "Update now", so it can never reload the page mid-count. `sw.js` is served `no-store` so updates arrive.
- Registered in production builds only (in development its caching would hide your edits).

**Offline queue.** `src/lib/offline/sync-queue.ts` (IndexedDB, fails soft), `src/providers/sync-provider.tsx`, `src/components/sync/*`.
- A count confirmed while offline, or whose request gets no answer, is stored with the SAME idempotency key it was sent with. It is shown as "saved on this device, not confirmed", never as confirmed. Only the server's answer confirms it.
- An entry is marked "attempted" BEFORE it is sent, so it can never be replaced by different numbers under a different key while the first might have been applied.
- Counts are sent oldest first and the queue stops at the first unresolved one (the server refuses to confirm a count dated before an already confirmed one).
- Sending is retried when the connection returns, when the app regains focus, and every 15 s while something waits. No background sync: iOS does not support it, so an offline count is sent the next time the app is open and online.
- Nothing is ever deleted automatically. Sign-out warns first if counts are still waiting.

**Conflict screen.** When the server answers with a conflict, the entry is kept in the "conflict" state and the person sees both sets of numbers side by side. A confirmed day can only be changed through the correction-approval flow, so there the choices are "keep the server's numbers" or look at the confirmed count. For a draft conflict they may also "use my numbers", which resends on top of the server's revision under a new key.

**Three real bugs found by running it for real** (the mocked unit tests could not see them; all now have regression tests):
1. Offline, "Review and confirm" refused to continue because it first saved the draft to the server. A network failure no longer blocks review; a server refusal still does.
2. When the connection returned, the form's old "push my draft" handler would create a server draft that put the queued copy in conflict with itself. A queued form stops saving.
3. `revalidatePath` inside the confirm action made Next re-render the page the person was on, replacing the success screen with the static "confirmed" page the moment the count saved. This predates Phase 11. Removed: the dashboard and history pages are dynamic and read fresh data on every visit (verified).

**Verification.** 736 unit/database tests; PWA browser tests on Chrome (real service worker, real offline); and a scripted run of two real browsers against a production build and the real local Supabase (offline confirm and sync with sales checked in the database, a genuine two-device conflict, mobile layout) with all 26 checks passing.

**Limits.** An offline count needs the app opened again once online if it was closed; the app cannot be opened from a closed state with no connection (signed-in pages are never cached by design); Safari may clear a website's stored data after about 7 days of non-use unless it is installed to the Home Screen; no push notifications yet; the Android and iPhone native apps are not built.


## Phase 11 (part 3): the phone app and its API

**Shape.** `mobile/` is an Expo (React Native) app, a thin client over a versioned JSON API in the web project (`src/app/api/v1/*`: `me`, `home`, `morning-stock`, `counts`, `variant-labels`). The phone cannot call Server Actions, so the API authenticates with the Supabase access token in `Authorization: Bearer` (validated on every request, and forwarded to the database so Row Level Security applies exactly as for the web). The service-role key is never involved. The shop is always taken from the caller's verified membership, never from the request body. Responses are `no-store`. CORS is closed unless `STOKIA_API_ALLOWED_ORIGINS` lists an origin (native apps do not need it; it exists for the browser test build).

**One implementation, two clients.** The route handlers and the web Server Actions call the same services: `count-submit.ts` (validation, server-side recomputation of every line from stored packaging, the `submit_count` call, conflict mapping) and `morning-stock.ts` (what the screen needs). The pure types (`count-types.ts`) live in a module both apps import, with a compile-time check that the validation schema and the shared `CountInput` type cannot drift apart.

**Shared rules, not copied rules.** The phone imports the web project's pure code through the `@/` alias (Metro watches `../src`; every shared package resolves from `mobile/node_modules`, one copy): calculations, packaging, count entry, dates, formatting, translations, permissions, the confirm decision (`confirm-flow.ts`: confirmed / kept on the device / conflict) and the offline-queue rules (`queue-engine.ts`). The queue engine is storage-agnostic; the web binds it to IndexedDB, the phone to SQLite. `tests/unit/helpers/queue-suite.ts` asserts the rules once and is run against both backends (SQLite through Node's real built-in engine).

**Offline on the phone.** Products, packaging, previous counts and prices are cached, so counting works with no signal (the count date comes from the phone's clock in the shop's time zone; the sales date is always the day before). The `ApiUnreachable` / `ApiSignedOut` errors are THROWN (never turned into a refusal), so the queue keeps the count and replays the same idempotency key; an expired session leaves the count queued until the person signs in again. The sign-in session is stored in the secure store, chunked because it exceeds one value's size limit, failing closed if a chunk is missing. Signing out removes the cached shop data and the queue (the person is warned first if counts are waiting).

**Verification.** Typecheck and lint (own ESLint setup), `expo-doctor`, Metro bundles for Android (1,524 modules) and iOS (1,378) as Hermes bytecode, 123 new unit/DB tests (API routes, queue suite on both backends, secure-storage chunking, API client, offline screen rebuild, translations, confirm flow), and a scripted run of the app's browser build against the real server and a real Supabase: sign-in errors, Home, language and theme, offline confirm then sync (sales checked in the database), unreachable-server fallback, a view-only role, sign-out wiping local data, and a genuine two-phone conflict. All of it passed.

**Bugs found while building it** (all fixed, with tests): the web form's "queued" screen kept promising "will be sent" after the server had reported a conflict (fixed on both apps); `Tabs` from `expo-router` is deprecated in SDK 58 (`expo-router/js-tabs` is used); a loader that set state before its first `await` tripped the React lint rule.

**Not verified: any physical device or emulator.** Native-only behaviour (the keyboard, the secure store, SQLite on the device, Expo Go) needs a real Android phone and iPhone before it is relied on. Not built: Products and Reports tabs, push notifications, biometric unlock, Inter / Noto Sans Sinhala fonts, report sharing. See `mobile/README.md`.


## Phase 11 (part 4): the phone's Products and Reports tabs

**API (all read-only, any shop member, same bearer-token rules as the rest of `/api/v1`):** `GET /api/v1/products`, `GET /api/v1/reports` (twelve months plus the latest confirmed counts), `GET /api/v1/reports/<month>` (the monthly report without its per-variant table, which can be thousands of rows) and `GET /api/v1/reports/<month>/file?format=pdf|xlsx|csv`. The month is validated exactly as the web does (a real month from 2000 up to the current one); anything else is a 400 before any work is done. Failures are a generic 500 with no message.

**Reuse, not copies.** The product list reuses the morning-count loader (asked "as of tomorrow", so the previous confirmed count is the latest one and the price is today's), so web and phone agree on prices, packaging and what "last counted" means. The report file is built by `report-file.ts`, now shared by the web download route and the phone route, so both produce the same file and the same audit record (the export is logged, and refused if it cannot be logged). The report notes use the web's exact wording through one pure function (`note-text.ts`). The response types live in pure modules (`catalog-types.ts`, `ReportIndexRow` in `report.ts`) so the phone never imports server-only files.

**Rules kept.** Money is always "Estimated". Units of different kinds are listed per unit, never added. A product nobody counted is "not counted yet", never "low"; a low-stock level of 0 means none was chosen. A day with no figure is drawn as a faint dot, never as a bar (and never as a sale of zero). The "days with figures" count is real days: the report's own `daysCalculated` counts product-days, which would have overstated it (found while testing).

**Sharing.** The file is fetched with the session token, its name is sanitised (no folders, no odd characters, never empty; a hostile server-supplied name cannot escape the cache folder), written to the app's private cache only for the moment of sharing, and deleted straight afterwards.

**Verification.** 52 new unit tests (the routes, the catalog's low-stock rule, product filtering and grouping, chart scaling, safe file names, the API client's binary download) and a scripted run of the phone app's browser build against the real server and Supabase (38 checks: filters, prices, packaging, last counted, low-stock, trend and month totals matching the database, a real PDF and CSV arriving and being logged, saved copies with the server unreachable, a viewer, Sinhala), plus the earlier 40 as a regression. Not verified on a physical device: the native share sheet and file writing.


## Phase 11 (part 5): stock movements on the phone

**API.** `GET /api/v1/movements` (any member: the 25 most recent, with who recorded each and whether it can still be undone), `POST /api/v1/movements` (needs `inventory.write`; body `{shopId, movement, key}`) and `POST /api/v1/movements/reverse` (`{shopId, movementId, reason, key}`). The shop always comes from the verified membership. A refusal (validation, a rule, a duplicate) is an ordinary 200 answer `{ok:false, error|fieldErrors}`; only a failure we cannot explain is a generic 500.

**One implementation, two front ends.** The web server actions used to hold the rules. They now delegate to `movement-submit.ts` (`recordMovementCore`, `reverseMovementCore`), which the phone routes call too: same schema, same unit conversion, same sign rules (`signedEffect`), same "when" resolution, same `record_movement` / `reverse_movement` functions. The web's 26 movement tests pass unchanged. The phone form's own logic (`mobile/src/features/movements/form.ts`) derives add / remove from the shared `signedEffect`, so the two cannot drift.

**Offline entry (added after the first version, which was online-only).** A movement changes stock and can rewrite a past day's estimated sales, so the queue is built around two risks: sending it twice, and sending it with the wrong time.
- *Twice:* each entry's id is its idempotency key. It is marked "maybe sent" BEFORE the request, so a crash mid-send cannot lead to it being discarded while the server may have applied it; no answer keeps it and replays the SAME key; `record_movement` answers "duplicate" for a key it already holds. The same happens when the phone is online but the answer is lost: the entry is saved with the same key instead of asking the person to retry.
- *Wrong time:* "just now" is fixed at entry as a chosen time (`when: "custom"`, the shop-local minute), and "before this morning's count" names the morning (`countDate`). The server's `resolveEffectiveAt` accepts that date (never a future one), so a movement sent days later still belongs to the count it was entered before. The database ignores time when matching a replay, so a replayed key returns the original.
- *Refusals:* a rule, a missing reason or a withdrawn product is an answer, so the entry is kept as "Not accepted" with the reason (retry / discard), and does not hold the others back (movements are independent; counts are not). "Before the count" is told to WAIT, not fail, while that morning's count is itself still queued (counts are sent first).
- *Not the same queue as counts:* the count queue is one sealed document per morning with conflict handling; movements are many, independent and conflict-free, so they have their own small engine (`movement-queue.ts`), SQLite table and tests, with the same safety rules.
- Undo stays online-only: it needs the recorded movement to exist.

**Timing.** "Before this morning's count" is the same choice as on the web: the movement belongs to the interval that count closed, so the previous day's estimate is recalculated (verified: Rs. 750.00 became Rs. 2,250.00 and returned to Rs. 750.00 after undoing). Undo never deletes: a reversal row cancels the original at its original time (`reversed_movement_id`), and a movement can be reversed once. Repacking is shown but is undone on the web.

**Navigation note (a real finding).** The screen first lived as a hidden tab (`href: null`). In this Expo Router version a hidden tab *redirects* instead of opening, so the button did nothing. It now lives inside the More tab's own stack (`more/index`, `more/movements`) and Home links to it; `popToTopOnBlur` makes More always reopen on the settings page.

**Verification of the online path.** 90 unit tests across the movement service, list mapping, routes and form logic, and a scripted run of the phone app's browser build against the real server and Supabase (32 checks: form validation with the web's wording, received-before-count recalculation matching the database, damaged and manual adjustment with direction, same-key retry returning `duplicate`, a dropped request then a safe retry, undo with a required reason and nothing deleted, a viewer who can look but not record and gets a 403 from the API, Sinhala, no console errors) with the earlier 40 + 38 as regression. Not verified on a physical device.

**Verification of the offline queue.** 55 new unit tests (the engine's rules on a real SQLite engine and on the browser store; the time-fixing, summary and "wait for the count" logic; the new server fields), and 15 more real-browser checks against the real server and Supabase (50 in all in that script): saving offline shows "Waiting to send" with nothing recorded; both entries survive a restart of the app; after the server answers they are sent by themselves, once, the damaged one at the time it was entered (seconds before it was sent) and the "before the count" one exactly one minute before that morning's count, which raised yesterday's estimate from Rs. 750.00 to Rs. 1,650.00; a product withdrawn while the phone was offline makes the entry "Not accepted" with the server's reason, and after the product is restored "Try again" records it once. One browser-build limit: the web test build loads each screen on demand, so the test opens the screen before going offline (a phone's single bundle does not have this limit).


## Phase 12: packaging-level selling and the optional sales breakdown

**The problem.** A product like Choco is counted in cartons, sold in boxes and as single pieces, at different prices (Piece Rs. 30, Box of 20 = Rs. 550, Carton of 10 boxes = 200 pieces, stock only). Until now every inferred unit was valued at the single-unit price. This phase lets the owner say which units are sold, price them, and say how many whole boxes of the previous day's inferred sales were sold, **without rebuilding anything** and without changing any existing figure.

**Data model (migration `20261107000012_packaging_sales_breakdown.sql`, additive).**
- `packaging_units.can_be_sold` (default false) and `can_be_counted` (default true): every existing unit keeps counting exactly as before and is not sold until the owner says so. `product_variants.base_unit_sellable` (default true) and the view `sale_units` give the base unit an explicit identity next to the packaging units.
- `packaging_unit_price_history`: price periods per sellable unit with no-overlap protection, written only by `set_packaging_price()` (owner; the previous period is closed, never edited or deleted; a new price cannot start before the latest began). The variant's existing selling price stays the price of the base unit, so nothing needs migrating.
- `sales_breakdowns` + `sales_breakdown_lines` (the base unit is flagged `is_base_unit`, never "a null that happens to mean base") + `sales_breakdown_revisions` (every create, change, clear, recalculation and "marked stale", with who, when and why). `daily_sales.packaging_status` is `unknown` / `known` / `stale`.

**The rule** (`src/lib/calculations/sales-breakdown.ts`, mirrored by `_breakdown_compute` in SQL; a parity test runs both on the same 13 cases): `packaged = sum(packages x base units each)` must not exceed the inferred units; `remainder = inferred - packaged` is sold in the base unit; `revenue = sum(packages x package price) + remainder x base price`, each price the one in force at noon (shop time) on the sales date. Choco: 145 sold with 4 boxes = 65 pieces, 4 x 550 + 65 x 30 = Rs. 4,150.00 (Rs. 4,350.00 without a breakdown). **It never touches stock:** no movement is created and the counts are unchanged.

**Server-side validation** (the database is the authority; TypeScript gives friendly messages): role (owner and stock manager; viewers read), whole non-negative package counts, total not above inferred, a price in force on the sales date, a unit that belongs to the product and is sellable, a calculated day, an idempotency key (a repeat returns the original; a key reused for a different request is refused), a reason to change or clear, and an optional expected revision so two people cannot overwrite each other.

**Corrections and recalculation.** `_recalc_sales_day` (patched in place, not rewritten) now uses a valid breakdown for the day's amount and re-checks every breakdown after any recalculation. If a corrected count or a movement shrinks the inferred sale so the boxes no longer fit, the breakdown is marked **stale** (kept, never deleted, never silently used): the day falls back to the plain estimate and the report says so. If a later change makes it fit again it is restored. Each of these is a revision with a reason, and the day's previous figure goes to `daily_sales_revisions` as before.

**Reporting.** `monthly_packaging_report` returns each calculated product-day as **known** (a breakdown), **unknown** (sellable in packages but no breakdown: an estimate at the single-unit price) or **standard** (no sellable packaging). The monthly report (screen, PDF, Excel, CSV, phone) shows the three groups apart, the packages sold per known product and the days with a known breakdown, and the three add up to Estimated Sales. Shops that do not use packaging prices see no new section.

**Interfaces.** Web: Packaging page (use of each unit, price and price history, base unit) and an optional, collapsed "Sales breakdown" panel on the morning-stock success screen and the stock-history page, loaded only when opened. Phone: the same panel as its own screen (`/more/sales-breakdown`), opened from Home and from the success screen. Both call the same shared form logic (`src/features/sales/breakdown-form.ts`); a test guards that neither re-implements the calculation. API: `GET/POST /api/v1/sales-breakdown`, `POST .../clear`, `GET .../history`.

**Where the panel is (and why).** A day's inferred sales only exist once the closing count is confirmed on the server, so the optional breakdown is offered right after confirmation (success screen) and later on the stock-history page. It is not in the count form or the pre-confirmation review, which stay uncluttered.

**Counting.** A unit with `can_be_counted = false` is hidden from the count form and refused by the server, but stays in the conversion chain (a carton made of boxes still converts: 2 cartons + 8 pieces = 408). Stock movements still accept any unit (cartons are received).

**Offline on the phone.** What is typed is kept as a draft on the phone (per person, shop, day and product; it only comes back while it still applies to the same revision, and signing out removes it). It is never sent by itself: Save needs a connection, and only the server's answer makes anything recorded. There is deliberately no background queue: a breakdown depends on a calculated day and on the revision the person saw.

**What the real-browser run found (and fixed), beyond the unit tests.**
- Every unit's price form used the same `id`, so a label pointed at another unit's field (duplicate ids on one page).
- A save made Next re-render the morning-stock page, replacing the success screen (and the panel) with the static "already confirmed" page: any `revalidatePath` inside a Server Action re-renders the page the person is on. The breakdown actions do not revalidate; the history page refreshes itself from the browser.
- The "saved" confirmation vanished at once, because the day reloads and the editor is rebuilt: it now lives in the panel / screen.
- After a save, the success screen and Home still showed the old total. They now follow the saved breakdown (web: the panel reports the day's new total; phone: Home and the success screen reload).
- `onChanged?.(await load())` skipped the reload whenever no handler was passed (caught by a unit test).

**Verification.** 54 database tests against the real migrations (the Choco figures, every refusal, idempotency, revisions, audit, stale and restore after a correction, row-level security, and 13 SQL/TypeScript parity cases); unit and component tests for the calculation, the shared form logic, the panel, the service, the API routes, the phone drafts and client, the report model and exports, the report view, the packaging actions and countable units; the security-verification script extended to the new tables and functions; and a real-browser run of the web app and the phone app's browser build against the real server and Supabase (63 checks: packaging setup, a real count with a carton, the panel, history, report, CSV and PDF, the phone draft, offline, restart and save, retries, a viewer). The three earlier phone scripts and the web offline/conflict script were re-run as regression. Not verified on a physical phone.

**Limits.** The breakdown only splits what the counts already inferred; it does not record individual sales or cash. Only whole packages of units marked sellable can be entered; a unit with no price on a given day cannot be used for that day (the first price can be dated earlier). The dashboard's daily sales include known splits (they are still Estimated Sales). A report saved on a phone before this release has no packaging section until it is opened again.

## Phase 13: Stock Sheet (renamed from Morning Stock) and another stock sheet on the same day

Each day has one stock sheet. A stock manager who needs to count again the same day asks with a reason (`request_recount`); the owner approves or rejects (`decide_recount`); only the person who asked can use the approval (`submit_recount`), only on its own day, only once. The owner may count again directly (their own request is auto-approved and still recorded). Viewers and other roles cannot.

An approved second count **replaces today's figures**. Nothing is deleted: every changed figure is written to `stock_count_corrections` (old and new quantity, reason), the session revision goes up, and the sales of the previous and current day are recalculated through the existing `_recalc_range`. Retrying a submit with the same key is safe. All rules are enforced in the database (migration `20261108000013_same_day_recounts.sql`, table `recount_requests`, no direct client writes); the web UI is `recount-panel.tsx` / `recount-sheet.tsx` on `/morning-stock` (`?recount=<id>`). Online only. The phone app shows the renamed tab but does not yet start an extra sheet.
