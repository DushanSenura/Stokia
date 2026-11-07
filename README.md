# Stokia — Count Today. Know Yesterday.

Daily stock and **estimated sales** for small shops in Sri Lanka. A shop counts its shelves each morning; Stokia works out what sold the day before.

Next.js (App Router) · TypeScript · Tailwind 4 · Supabase (Postgres, Auth, Row Level Security) · LKR · Asia/Colombo · English + Sinhala · light/dark · desktop, tablet, phone.

## Status: all 10 phases built

| | |
|---|---|
| 1 | Foundation, design system, landing page with live calculator, auth, database with RLS |
| 2 | Products, size variants, categories, price history, images, CSV import/export |
| 3 | Packaging (bundle → packet → piece) and the conversion engine |
| 4 | Morning stock entry: autosaved drafts, bundle + loose entry, review, atomic confirm; stock history |
| 5 | Stock movements (receive, damage, return, adjust, repack, reverse) and the reconciliation engine |
| 6 | Live dashboard, charts, low-stock alerts, notification bell |
| 7 | Sales analytics and monthly reports (PDF, Excel, CSV) |
| 8 | Roles and permissions, team invitations, count-correction approval, settings, audit log, security hardening, Sinhala for the daily workflow |
| 9 | Entries kept on the device, data health check and repair, backup download, large-catalog performance |
| 10 | Cross-browser and end-to-end tests, security headers, CI, deployment guide |
| 11 | *Phone and offline work.* Done: retry-safe, conflict-aware count submission; installable app (PWA) for Android and iPhone; counts kept on the device when offline and sent when back online; conflict screen; **native phone app** (`mobile/`: sign-in, Home, the full morning count with offline queue and conflicts, view-only Products, Reports with PDF / Excel / CSV sharing, settings) on a versioned API. The phone app has not yet been run on a real phone or emulator. Not yet: editing products on the phone, stock movements, push notifications, biometric unlock |

**Before you launch, read [docs/deployment.md](docs/deployment.md), especially "First-deploy checks" and "Known limits".** The code has not yet run against a real Supabase project.

## The one business rule
The morning count on day **D** calculates sales for day **D−1**: `opening + received + customer returns − damaged/expired/discarded − closing`.
- A **blank is "not counted"**, never zero. A missing count leaves sales **pending**.
- Stock that *rose* with nothing recorded is **needs review**, never a negative sale.
- Money is always **Estimated Sales**, never confirmed revenue.
- Quantities of different base units (kg vs. packets) are never added together.
- A monthly report uses the opening count on the 1st and the closing count on the 1st of next month; until that closing count is confirmed the month is "in progress".

Core: `src/lib/calculations/inferred-sales.ts`, mirrored in SQL and checked against it by a randomised parity test.

## Run locally
```bash
npm install
cp .env.example .env.local      # fill in your Supabase URL + anon key
npm run dev
```
Without Supabase keys the site and calculator work; sign-in explains the missing configuration.
Design review without a database: `STOKIA_PREVIEW=1 npm run dev`, then open `/preview/dashboard`, `/preview/analytics`, `/preview/report`, `/preview/settings` (demo data; 404 in production).

## Scripts
| | |
|---|---|
| `npm test` | 640+ unit, component and database tests. The database tests run the **real migrations** on an in-process Postgres (PGlite) with Supabase stand-ins. |
| `npm run e2e` | Playwright on Chrome desktop + Pixel 7 (builds the production app first) |
| `npm run e2e:all` | adds Firefox, Safari (WebKit) desktop and iPhone: 390 tests including axe accessibility and security-header checks |
| `npm run verify` | typecheck + lint + tests + all browsers (what CI runs) |

## How it is checked
- **Calculations:** worked examples from the specification, property-style tests, and an SQL-versus-TypeScript parity test.
- **Security:** every capability × role is exercised against the real database; `supabase/tests/rls_verify.sql` must return zero rows; append-only tables reject client writes.
- **Reliability:** the data health check re-runs the real reconciliation in a rolled-back transaction and compares; repair keeps history.
- **Accessibility:** axe (WCAG 2.0/2.1 A and AA, serious/critical) on public pages and the demo previews, light and dark, desktop and phone.
- **Browsers:** Chromium, Firefox, WebKit; desktop, Android and iPhone viewports; no horizontal scroll from 320 px to 1440 px; no console errors or CSP violations.

## Phone app
`mobile/` is the native Android and iPhone app (Expo). It shares the business rules with the web app and talks to it through `/api/v1`. Setup, running it, building installable files and its honest limits are in [mobile/README.md](mobile/README.md).

## Documentation
- [docs/architecture.md](docs/architecture.md): layers, security model, every phase's design decisions and trade-offs.
- [docs/deployment.md](docs/deployment.md): Supabase setup, environment variables, first-deploy checks, operations, known limits.

## Honest limits
- Sinhala covers the daily workflow and needs review by a native speaker; other screens fall back to English.
- Estimated Sales are only as good as the counts and recorded movements. Unrecorded loss is absorbed into the estimate, which is why every figure is labelled "Estimated".
- Backup is a download, not a restore button.
- Performance was measured on an in-process database, not Supabase under load.


login

Email: owner@stokia.local
Password: Stokia-Local-2026!