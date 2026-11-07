# Stokia phone app (Android and iPhone)

The native app for the daily job: count the shelves each morning, with or without a connection, and see what sold yesterday. It is a real native app (Expo / React Native), not a website in a frame, and it shares its business rules with the web app.

## What works today

| | |
|---|---|
| Sign in / out | Email and password, session kept in the phone's secure store (Keychain / Keystore), password recovery by email |
| Home | Is this morning's count done, and yesterday's **estimated** sales (per unit: units of different kinds are never added together). Works offline from the last saved view |
| Stock Sheet | The whole counting flow: search, filters, big numeric inputs, bundles and loose items, live total / change / estimated sold, review, confirm. Unfinished entries are kept on the phone as you type |
| Offline | Products are saved on the phone, so you can count with no signal. A count confirmed offline is kept on the phone and **never shown as confirmed** until the server accepts it |
| Conflicts | If another device counted the same morning, you see both sets of numbers side by side. Nothing is ever overwritten |
| Products | Browse and search products, filter by category or "low stock only", see each size's selling price, last counted quantity, low-stock flag and how the packaging nests. **View-only** on the phone (any role); products are added and changed in the web app. A product nobody counted says "not counted yet", never "low" |
| Reports | Six-month trend, the monthly reports (status, estimated sales), recent confirmed counts, and for each month: totals, a daily chart, best sellers (per unit, never added across units), the stock summary, low stock and the report's own notes. **Share** the report as PDF, Excel or CSV through the phone's share sheet (the same file the web app downloads; every export is logged exactly as on the web). Months and lists you have opened stay available with no connection |
| Stock movements | Opened from a button on Home or on More. Record stock received, customer or supplier returns, damaged / expired / discarded stock and manual adjustments (add or remove), in a bundle or loose, with a reason or reference, and **when** it happened ("just now" or "before this morning's count", which recalculates the previous day's estimated sales). See the recent movements and **undo** a mistake with a reason: nothing is deleted, a matching entry cancels it and affected sales are recalculated. **Works offline:** an entry made with no connection waits on the phone in a "Waiting to send" list (clearly marked as not recorded), survives closing the app, and is sent by itself when the phone is online, with the time it was entered. Undoing a movement needs a connection. People who can only view see the list but not the buttons. Repacking is done in the web app |
| Known box sales | Optional, from a button on Home or on the success screen after a count. For each product that is sold in packages (a box of 20, say) enter how many **whole boxes** were sold yesterday: the rest of the inferred sales are counted as single units and each is priced with that day's price. You see the preview (boxes, loose pieces, revenue) before saving, and the plain estimate for comparison. It never changes stock. Changing it later needs a reason, and its history shows who changed what. What you type is kept as a **draft on the phone**; Save needs a connection and nothing is confirmed until the server accepts it |
| More | Account, shop and role, English / Sinhala, light / dark / system, counts waiting to send, sign out |

**Not built yet:** adding and editing products or prices on the phone (including packaging prices), repacking on the phone, push notifications, fingerprint / face unlock, a stock-history detail screen. Nothing in the app is a dead button: unfinished areas simply are not shown.

## How it is built

- **A thin client.** Every read and write goes through the Stokia server API (`/api/v1`, in the web project). It authenticates with the signed-in session's token, and the database's Row Level Security applies exactly as it does for the web app. Supabase is used by the phone only to sign in and refresh the session. **The phone never holds a service-role key.**
- **One set of rules.** The calculations, packaging conversion, count entry, dates, translations and the offline-queue rules are the web project's own pure code (`../src`), imported through the `@/` alias, not copied. The offline queue runs the same engine over SQLite on the phone and over IndexedDB on the web, and the same test suite is run against both.
- **Same safety rules as the web.** Every count is sent with an idempotency key. A retry (lost response, no signal, a crash) replays the SAME key, so a count the server already applied is never applied twice. A stale or contested count returns a conflict, never an overwrite.

## Run it on Windows

1. Install Node.js 22.13 or newer (24 is fine; Node 25 works but Expo warns that it is unsupported).
2. In the web project's folder, start the web app and a Supabase project (see `docs/deployment.md`; for local testing `npx supabase start`).
3. In this folder:
   ```
   npm install
   copy .env.example .env      (then fill it in)
   npx expo start
   ```
4. Scan the QR code with **Expo Go** on your phone (Android or iPhone), or press `a` for an Android emulator.

**Using a real phone: "localhost" is the phone itself.** In `.env`, use your computer's address on the same Wi-Fi (for example `http://192.168.1.20:3000`) for the web app and for Supabase, or use a deployed web app and a hosted Supabase project. The Android emulator reaches your computer at `http://10.0.2.2`. The web app needs no special setting for native apps (they do not use CORS).

Run `npm run preflight` before you start: it catches `localhost` on a real phone, a secret key in the app and an unreachable server. The full step-by-step route to a real phone, and a checklist of what to test, is in [../docs/device-testing.md](../docs/device-testing.md).

Expo Go carries a fixed set of native modules. This app only uses modules Expo Go includes (SecureStore, SQLite, Network, Crypto), so Expo Go is enough for testing.

## Install it on phones (builds)

Builds are made in Expo's cloud (EAS), so no Mac, Xcode or Android Studio is needed.

```
npx eas-cli login
npx eas-cli build --platform android --profile preview     # an installable .apk
npx eas-cli build --platform ios --profile preview         # needs an Apple Developer account, see below
```
Fill in the `env` block of the profile in `eas.json` first (your real web address, Supabase URL and public key).

- **Android:** free. An `.apk` from the `preview` profile installs directly. Google Play needs a one-time US$25 developer account and an `app-bundle` (`--profile production`).
- **iPhone:** installing anywhere except Expo Go needs the **Apple Developer Program (US$99 per year)**. `preview` builds install on devices you register; TestFlight and the App Store need the same membership and App Store review. Expo Go is the free way to try the app on an iPhone.
- **Before the first store upload, change the app identifiers** (`com.novacoretechs.stokia` in `app.json`, for both iOS and Android). They are permanent once published. They are a placeholder.

## Checks

```
npm run typecheck        # TypeScript
npx expo lint            # lint
npx expo-doctor          # dependency and configuration health
npx expo export --platform android     # Metro bundles it for Android (and ios, and web)
```
The web project's `npm test` also covers this app's pure logic: the SQLite queue store on a real SQLite engine, the secure-storage chunking, the API client, the offline screen rebuild and the translations. A scripted end-to-end run drives the app (its browser build) against the real server and a real Supabase: sign in, count offline and sync, a two-device conflict, a view-only role, unreachable-server fallback and sign-out.

## Honest limits

- **It has not been run on a physical Android phone or iPhone, or in an emulator.** It has been type-checked, linted, bundled for Android and iOS, and exercised end to end in a browser build against the real backend. Native-only behaviour (the keyboard, the secure store, SQLite on the device, Expo Go) still needs a real-device test before you rely on it.
- No background sync: an offline count is sent the next time the app is open and online.
- Sharing a report needs a connection (the file is built on the server). The share sheet itself (`expo-sharing`) has only been exercised through the browser build's download, not on a physical phone.
- A stock movement entered offline is **not recorded** until the server accepts it, and the screen says so. It keeps the time it was entered (a "before this morning's count" entry keeps the morning it was entered), so sending it later does not move it into another day's sales. The server can still refuse it (for example the product was withdrawn meanwhile): it is then kept, marked "Not accepted" with the reason, and can be tried again or discarded. An entry that may already have reached the server cannot be discarded. Undoing a recorded movement is online only. Waiting entries are deleted if you sign out (you are warned first).
- Reports are read from the server as of the moment you open them; a saved copy of a month does not update by itself.
- The browser build uses localStorage instead of the secure store and SQLite. It exists only for testing and is not a supported way to run the app.
- The Sinhala is not reviewed by a native speaker.
- Text uses the same typefaces as the web app (Inter, Noto Sans Sinhala), bundled in the app in three weights (regular, semibold, bold). The app waits at most 4 seconds for them and then carries on in the phone's own font, so a font problem can never lock anyone out. Verified in the browser build (the right family is applied and the files load); how they look on a real phone is not verified.
- The API has no rate limiting beyond Supabase's own.
