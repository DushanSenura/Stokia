# Deploying Stokia

This guide takes you from an empty Supabase project to a running shop. Follow it in order. Nothing here has been run against a real Supabase project by the developers yet (all database tests use an in-process Postgres with the real migrations), so **do the "First-deploy checks" at the end and treat any surprise as a bug to report.**

## 1. What you need
- A Supabase project (any region; pick one close to Sri Lanka, e.g. Singapore or Mumbai).
- A host for the Next.js app that supports Node 20+ (Vercel is the simplest; any Node host works with `npm run build && npm start`).
- A domain with HTTPS (the app sends HSTS and `upgrade-insecure-requests`).

## 2. Supabase
1. **Create the project.** Note the project URL, the anon (publishable) key and the service-role key (Project Settings → API).
2. **Authentication → Providers → Email:** turn **off** "Allow new users to sign up". Stokia is invitation-only; a stranger must not be able to create an account.
3. **Authentication → URL Configuration:** set *Site URL* to your production URL and add `<site>/auth/callback` to *Redirect URLs*.
4. **Apply the 12 migrations in order** (`supabase/migrations/20261106000001…000011`, then `20261107000012`). The last one is additive (packaging-level selling and the sales breakdown): it changes no existing row and no existing figure. With the CLI: `supabase link --project-ref <ref>` then `supabase db push`. Or paste each file into the SQL editor, in order. They create tables, Row Level Security, functions and the product-image storage bucket.
5. **Run the security verification.** Paste `supabase/tests/rls_verify.sql` into the SQL editor. It must return **zero rows**. Any row is a security problem: do not go live until it is empty.
6. **Backups.** Turn on Supabase's own backups (daily backups on paid plans; point-in-time recovery if you can afford it). The in-app backup download is a second, owner-controlled copy, not a replacement.
7. **Create the first owner:** Authentication → Users → *Invite user* (or "Add user" with a password). They sign in and create their shop at `/setup`. From then on the owner invites everyone else from Settings → Team.

## 3. Environment variables
| Variable | Where | Purpose |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | build + runtime | Project URL. **Also sets the Content-Security-Policy**, so it must be present at *build* time. |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | build + runtime | Public key. Safe in the browser; Row Level Security is what protects data. |
| `NEXT_PUBLIC_SITE_URL` | build + runtime | Your public URL, no trailing slash. Used in password-reset and invitation e-mails. |
| `SUPABASE_SERVICE_ROLE_KEY` | runtime, **server only** | Needed only to invite team members. **Never** prefix with `NEXT_PUBLIC_`, never commit it. Without it everything works except inviting. |
| `STOKIA_API_ALLOWED_ORIGINS` | runtime, optional | Comma-separated browser origins allowed to call `/api/v1` (the phone app's API). **Leave unset in production**: native phone apps do not use CORS, so nothing needs it. It exists only so a browser-based test build of the phone app can reach the server. Never use `*`. |
| `STOKIA_PREVIEW` | leave **unset** in production | `1` enables the demo-data `/preview/*` routes used for screenshots and tests. They 404 without it. |
| `STOKIA_PLAIN_HTTP` | leave **unset** in production | `1` drops `upgrade-insecure-requests`; only for testing a production build over plain http. |

## 4. Deploy
**Vercel:** import the repository, add the variables above (apply the three `NEXT_PUBLIC_*` to Production *and* Preview), deploy. Set the health check / uptime monitor to `GET /api/health` (200 = configured, 503 = a required variable is missing; it returns only booleans).

**Any Node host:** `npm ci && npm run build && npm start` behind HTTPS. Put the variables in the process environment before `npm run build`.

## 5. First-deploy checks (do these once, in this order)
1. `GET /api/health` returns `{"status":"ok", …}` and `invitations: true`.
2. Response headers on `/` include `Content-Security-Policy`, `Strict-Transport-Security`, `X-Frame-Options: DENY`. (`curl -I https://your-site/`.)
3. The `rls_verify.sql` result is empty (step 2.5 above).
4. Sign in as the owner, create the shop, add one product with a selling price, confirm a first morning count. The dashboard should say sales will appear after the *next* morning's count.
5. Next day: confirm a second count. Yesterday's Estimated Sales should appear and equal `opening + received + returns − damaged − closing` × price. Open Settings → Data and run the health check: it must report no problems.
6. Invite a stock manager and a viewer from Settings → Team. Sign in as each and confirm: the manager can count and request corrections but cannot open Settings → Team; the viewer cannot count.
7. Sign out and open `/morning-stock`: you must be sent to the sign-in page.
8. Settings → Data → *Download backup file*. Check the file opens and is not empty.
9. On a real phone: open `/install`, install Stokia, then switch on airplane mode and enter and confirm a count. It must say "Saved on this device… NOT confirmed". Turn airplane mode off with the app open: a notice says it was sent and confirmed.
10. Try a conflict once: count the same morning on two devices (one offline). The offline one must be told the counts do not match and must not overwrite the other.
11. Phone app: build it (`mobile/README.md`), sign in on a real Android phone and, if you have the Apple account, a real iPhone. Repeat checks 9 and 10 there. Confirm that signing out removes the cached data.

## 6. Content Security Policy: what it does and does not do
Restricts network calls to this site and your Supabase project, forbids framing, plugins and foreign form targets. It still allows inline scripts and styles (`'unsafe-inline'`) because Next.js injects small inline bootstrap scripts and the UI uses style attributes. A nonce-based policy would be stricter but forces every page, including the marketing page, to render per request; it was left out deliberately and can be added later following Next's CSP guide.

## 7. Operations
- **Rotating keys:** change `SUPABASE_SERVICE_ROLE_KEY` in the host, redeploy. Rotating the anon key requires a rebuild (it is compiled into the browser bundle).
- **Adding a migration:** add a new numbered file; never edit an applied one. Re-run `rls_verify.sql` afterwards.
- **Something looks wrong in the numbers:** Settings → Data → *Run the check*. If it reports stored sales that differ from a recalculation, *Recalculate sales* repairs them and keeps the old figures in history.
- **Restoring from the backup file:** not self-service (see `docs/architecture.md`, Phase 9). Keep the file private; verify it with `verifyBackup` (`src/features/data/backup.ts`).
- **Time zone:** the shop's time zone is fixed once the first count is confirmed, because changing it would move every historical sale to a different day.

## 8. Known limits (read before launch)
- The Sinhala translation covers the daily workflow and was **not reviewed by a native speaker**. Have one review `src/i18n/si-core.ts`. Untranslated screens show English.
- Performance numbers (3,000 products, sub-second reconciliation) come from an in-process database, not from Supabase under real load.
- Offline support: counts entered or confirmed while offline are kept on the phone and sent when the app is open and online (never shown as confirmed before the server accepts them). There is no background sync (iOS does not support it), the app cannot be opened from a closed state with no connection (signed-in pages are deliberately never cached), and Safari may clear a site's stored data after about 7 days of non-use unless the app is added to the Home Screen. Test this on a real Android phone and a real iPhone before relying on it.
- The installable app (PWA) needs HTTPS in production. Android installs from Chrome; on iPhone use Safari, Share, Add to Home Screen. The steps are on the public `/install` page.
- The native phone app (`mobile/`, Expo) covers sign-in, Home, the whole morning count with offline queue and conflict handling, and settings. It has **not been run on a physical phone or an emulator**: it was type-checked, bundled for Android and iOS, and exercised end to end in a browser build against the real backend. Products, Reports, push notifications and biometric unlock are not built yet. Installing the web app as a PWA remains the supported way to get the full feature set on a phone. See `mobile/README.md` for building with EAS; an iPhone install outside Expo Go needs an Apple Developer account (US$99 per year).
- The phone app talks to the server through `/api/v1`, so the web app must be deployed and reachable from phones over HTTPS, and the phone build's `EXPO_PUBLIC_API_URL` must point at it.
- Estimated Sales are inferred from counts and recorded movements. If an item leaves the shelf without being recorded (theft, an unrecorded delivery), the estimate absorbs it. The app labels every figure "Estimated" for this reason.
