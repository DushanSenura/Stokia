# Testing Stokia on a real phone

The phone app has been type-checked, linted, bundled for Android and iOS and driven end to end in a browser build against the real server and database. It has **not** run on a real phone. This page is the shortest safe route to doing that, and a checklist of what only a real phone can prove.

## 0. Check the configuration first

Most first-run failures are an address, not a bug. In `mobile/`:

```
copy .env.example .env        # then fill it in
npm run preflight             # for Expo Go / development
npm run preflight -- --profile preview      # before building an installable file
```

It fails (exit code 1) on: a placeholder left in, `localhost` in an installed build, plain `http` in an installed build, a **service-role key** in the app (anyone who installs the app could extract it), a Stokia server that does not answer, and a Supabase project that refuses the key. It warns when `localhost` / `127.0.0.1` would point a real phone at itself. It checks from your computer; also open the same address in the phone's browser to prove the phone can reach it.

## 1. Fastest: Android or iPhone with Expo Go, on your own Wi-Fi (free)

1. Phone and computer on the **same Wi-Fi**.
2. Find your computer's address: `ipconfig` -> "IPv4 Address" (for example `192.168.1.20`).
3. Start Supabase (`npx supabase start`) and the web app. For a phone to reach the web app it must listen on the network: `npx next dev -H 0.0.0.0` (or build and `npx next start -H 0.0.0.0 -p 3000`; build with `STOKIA_PLAIN_HTTP=1` so the page security policy allows plain http).
4. In `mobile/.env`, use that address everywhere, for example `EXPO_PUBLIC_API_URL=http://192.168.1.20:3000`, `EXPO_PUBLIC_SUPABASE_URL=http://192.168.1.20:54321`, `EXPO_PUBLIC_SITE_URL=http://192.168.1.20:3000`. Keep the anon key from `npx supabase status`.
5. Windows Firewall: allow inbound connections for Node on a **private** network when it asks (ports 3000, 54321 and Expo's 8081). If the phone cannot open `http://192.168.1.20:3000` in its browser, nothing in the app will work either.
6. `npm run preflight`, then `npx expo start` and scan the QR code with **Expo Go** (Android) or the Camera app (iPhone).

Expo Go allows plain http. **Installed builds do not** (see section 2).

If Expo Go says the project needs a different SDK, the store version of Expo Go may lag behind SDK 58; use a development build (section 2) instead.

## 2. An installable app (needs a deployed web app)

Installed builds refuse plain http, so they need the web app on **https** and a hosted Supabase project (see `deployment.md`). A computer on your Wi-Fi cannot be used for these.

```
cd mobile
npx eas-cli login
# fill in the env block of the "preview" profile in eas.json with the real https addresses
npm run preflight -- --profile preview
npx eas-cli build --platform android --profile preview     # an .apk you can install directly
```

- **Android:** free. Open the build's link on the phone and install the `.apk` (allow "install unknown apps" once).
- **iPhone:** an installable build, TestFlight or the App Store needs the Apple Developer Program (US$99 per year). Without it, Expo Go (section 1) is the free way to try the app on an iPhone.
- **Before any store upload,** change `com.novacoretechs.stokia` in `app.json` (iOS and Android). It is a placeholder and is permanent once published.
- Supabase -> Authentication -> URL configuration: add the web app's address as the Site URL, so password-reset emails link to it.

## 3. What to check on the phone (only a real phone can prove these)

Use a test shop, not real data. Tick each one.

**Sign-in and storage**
- [ ] Sign in; close the app completely; reopen: still signed in (the session is kept in the Keychain / Keystore).
- [ ] Sign out; reopen: asked to sign in. Wrong password shows a clear message.

**Counting offline** (the central promise)
- [ ] Open the Stock Sheet with a signal so products load. Turn on **airplane mode**.
- [ ] Enter a count and confirm. It says **waiting to send**, never "confirmed".
- [ ] Close the app (swipe it away) and reopen in airplane mode: the waiting count is still there (SQLite on the device).
- [ ] Turn airplane mode off, open the app: the count is sent and now shows as confirmed on Home and in the web app. Sent once, not twice.
- [ ] Two phones, same shop, same morning: the second sees the **conflict screen** with both sets of numbers, and nothing is overwritten.

**Keyboard and inputs**
- [ ] The number pad appears for quantities; decimals work for loose items; the Save / Confirm button is not hidden behind the keyboard.
- [ ] Search fields do not autocorrect product names.

**Products, Reports, sharing**
- [ ] Products: search, category filter, "low stock only", prices.
- [ ] Reports: the month opens; the chart is readable in sunlight and in dark mode.
- [ ] **Share a PDF and an Excel file** through the phone's share sheet (WhatsApp, email, Files). Open the received file and check the figures match the screen. This is the one piece only exercised through a browser download so far.

**Stock movements**
- [ ] Record "stock received", "before this morning's count": yesterday's estimated sales change on Home.
- [ ] Undo it with a reason: sales return to the earlier figure.
- [ ] Turn airplane mode on and record a movement: the button says "Save on this phone", the entry appears under "Waiting to send" and is NOT in the recorded list. Close the app completely and reopen it (still offline): the entry is still waiting.
- [ ] Turn airplane mode off and open the app: the entry is sent by itself within about 15 seconds and moves to the recorded list, once. Check in the web app that it is recorded once, with the time you entered it (not the time it was sent).
- [ ] Record one as "before this morning's count" while offline, then send it: yesterday's estimated sales change on Home.
- [ ] Sign out with an entry still waiting: you are warned that it will be deleted.

**Known box sales** (needs a product sold in packages with a price; see the Packaging page on the web)
- [ ] After a count, tap "Add known box sales (optional)": the products appear, and the inferred pieces match yesterday's estimate on Home.
- [ ] Type a number of boxes: the preview shows the boxes, the loose pieces and the revenue. Too many boxes shows an error and cannot be saved.
- [ ] Turn airplane mode on and press Save: it says it needs a connection and keeps what you typed. Close the app completely and reopen it online: the draft is back. Press Save: it is recorded once.
- [ ] Change a saved breakdown: it asks for a reason, and "History" shows who changed it. Home's total follows the change without restarting the app.
- [ ] A view-only person can open it but cannot change anything.

**Look and language**
- [ ] Sinhala letters render correctly (no empty boxes), also in the bottom tab bar, on both phones.
- [ ] Month names read in Sinhala (ජනවාරි ... දෙසැම්බර්) in Sinhala mode.
- [ ] Light, dark and "system" themes; text stays readable with the phone's large-text setting on.
- [ ] Rotate / small phone: nothing is cut off; every button is easy to tap.

Write down anything that fails with the phone model and Android / iOS version; those are the bugs the browser build could not show.

## Known limits on a device

- No background sync: a waiting count is sent the next time the app is open and online.
- Stock movements entered offline are sent when the app is open and online. Undoing a recorded movement needs a connection.
- The Sinhala has not been reviewed by a native speaker.
