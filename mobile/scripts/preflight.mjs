// Checks the phone app's configuration BEFORE you build or scan a QR code, and catches the mistakes that waste an afternoon on a real
// phone: "localhost" (which is the phone itself), plain http in a build that will refuse it, a secret key baked into the app, a
// server that cannot be reached.
//
//   node scripts/preflight.mjs                    checks mobile/.env (or the environment) for running with Expo Go
//   node scripts/preflight.mjs --profile preview  also applies the rules for an installable build (https only, no local addresses)
//   (profiles: dev | preview | production)
//
// Values already set in the environment win over mobile/.env. Exit code 1 if anything FAILS, so it can sit in a script or CI step.
import { Buffer } from "node:buffer";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const profile = args.includes("--profile") ? args[args.indexOf("--profile") + 1] : "dev";
if (!["dev", "preview", "production"].includes(profile)) { console.error(`Unknown profile "${profile}" (use dev, preview or production)`); process.exit(2); }
const release = profile !== "dev";

const fromFile = {};
const envFile = path.join(here, "..", ".env");
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*(EXPO_PUBLIC_[A-Z_]+)\s*=\s*(.*?)\s*$/);
    if (m) fromFile[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
const val = (k) => (process.env[k] ?? fromFile[k] ?? "").trim();
const API = val("EXPO_PUBLIC_API_URL"), SB = val("EXPO_PUBLIC_SUPABASE_URL"), KEY = val("EXPO_PUBLIC_SUPABASE_ANON_KEY"), SITE = val("EXPO_PUBLIC_SITE_URL");

let failures = 0, warnings = 0;
const pass = (m) => console.log(`  ok    ${m}`);
const warn = (m) => { warnings++; console.log(`  WARN  ${m}`); };
const fail = (m) => { failures++; console.log(`  FAIL  ${m}`); };

const parse = (name, v) => {
  if (!v) { fail(`${name} is not set.`); return null; }
  if (/YOUR-|your-/.test(v)) { fail(`${name} is still the placeholder "${v}". Put the real address in.`); return null; }
  try { return new URL(v); } catch { fail(`${name} ("${v}") is not a valid address. It should look like https://example.com`); return null; }
};
const isLoopback = (h) => h === "localhost" || h === "127.0.0.1" || h === "::1" || h === "[::1]";
const isPrivate = (h) => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.)/.test(h) || h.endsWith(".local");

function addressRules(name, url) {
  if (!url) return;
  const h = url.hostname;
  if (isLoopback(h)) {
    if (release) fail(`${name} points at "${h}", which on a phone is the phone itself. A ${profile} build needs the real https address.`);
    else warn(`${name} uses "${h}". That works for an emulator on this computer or the web build, but on a REAL phone it is the phone itself. Use this computer's address on your Wi-Fi (like http://192.168.1.20:3000).`);
  } else if (h === "10.0.2.2") {
    if (release) fail(`${name} uses 10.0.2.2, which only the Android emulator understands.`);
    else pass(`${name} uses 10.0.2.2 (Android emulator only; a real phone will not reach it)`);
  } else if (isPrivate(h)) {
    if (release) fail(`${name} is a local-network address (${h}). A ${profile} build is for other people's phones: use the deployed https address.`);
    else pass(`${name} is a local-network address (${h}); the phone must be on the same Wi-Fi`);
  }
  if (url.protocol === "http:" && release) fail(`${name} uses plain http. Installed builds refuse plain http by default (Android and iPhone both); use https.`);
  else if (url.protocol === "http:") pass(`${name} uses http, which Expo Go and development builds allow`);
  else if (url.protocol === "https:") pass(`${name} uses https`);
}

console.log(`Stokia phone app preflight (profile: ${profile})\n`);
console.log("Configuration");
const apiUrl = parse("EXPO_PUBLIC_API_URL", API);
const sbUrl = parse("EXPO_PUBLIC_SUPABASE_URL", SB);
addressRules("EXPO_PUBLIC_API_URL", apiUrl);
addressRules("EXPO_PUBLIC_SUPABASE_URL", sbUrl);
if (SITE) { const s = parse("EXPO_PUBLIC_SITE_URL", SITE); if (s && s.protocol === "http:" && release) fail("EXPO_PUBLIC_SITE_URL uses plain http; the password-reset link would not open safely."); }
else warn("EXPO_PUBLIC_SITE_URL is not set, so \"Forgot password\" has nowhere to send people. Set it to the web app's address.");

// The key is baked into the app and readable by anyone who installs it. It must be the public (anon / publishable) key.
if (!KEY) fail("EXPO_PUBLIC_SUPABASE_ANON_KEY is not set.");
else if (/YOUR-|your-/.test(KEY)) fail("EXPO_PUBLIC_SUPABASE_ANON_KEY is still the placeholder.");
else if (/^sb_secret_/.test(KEY)) fail("EXPO_PUBLIC_SUPABASE_ANON_KEY is a SECRET key (sb_secret_...). It would be baked into the app for anyone to extract. Use the anon / publishable key.");
else if (/^sb_publishable_/.test(KEY)) pass("the Supabase key is a publishable key");
else if (KEY.split(".").length === 3) {
  try {
    const role = JSON.parse(Buffer.from(KEY.split(".")[1], "base64url").toString("utf8")).role;
    if (role === "anon") pass("the Supabase key is the anon (public) key");
    else fail(`the Supabase key has role "${role}". Only the anon key may be put in the app: a service_role key would give every installer full access to your data.`);
  } catch { warn("the Supabase key looks like a JWT but could not be read; make sure it is the anon key."); }
} else warn("the Supabase key is in an unfamiliar format; make sure it is the anon / publishable key and not a secret.");

async function get(url, init) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 8000);
  try { return await fetch(url, { ...init, signal: ctl.signal }); } finally { clearTimeout(timer); }
}

console.log("\nReachability (from this computer)");
if (apiUrl) {
  try {
    const res = await get(new URL("/api/v1/me", apiUrl), { headers: { Accept: "application/json" } });
    let body = null; try { body = await res.json(); } catch { /* not JSON */ }
    if (res.status === 401 && body && body.ok === false) pass(`the Stokia server answers at ${apiUrl.origin} (it correctly refuses a request with no sign-in)`);
    else if (res.status === 404) fail(`${apiUrl.origin} answers, but /api/v1/me is not there. Is this the Stokia web app, and is it a version with the phone API?`);
    else fail(`${apiUrl.origin}/api/v1/me answered ${res.status}, not the expected 401. Is this the Stokia web app?`);
  } catch (e) { fail(`cannot reach the Stokia server at ${apiUrl.origin} (${e.name === "AbortError" ? "no answer in 8 s" : e.cause?.code ?? e.message}). Is it running? On Windows, allow it through the firewall if the phone is to reach it.`); }
}
if (sbUrl && KEY) {
  try {
    const res = await get(new URL("/auth/v1/health", sbUrl), { headers: { apikey: KEY } });
    if (res.ok) pass(`Supabase answers at ${sbUrl.origin} and accepts the key`);
    else if (res.status === 401 || res.status === 403) fail(`Supabase at ${sbUrl.origin} refused the key (${res.status}). Copy the anon / publishable key from Project Settings -> API.`);
    else fail(`Supabase at ${sbUrl.origin} answered ${res.status}.`);
  } catch (e) { fail(`cannot reach Supabase at ${sbUrl.origin} (${e.name === "AbortError" ? "no answer in 8 s" : e.cause?.code ?? e.message}). Is it running (npx supabase start)?`); }
}
if (!release) console.log("\nNote: this checks from THIS computer. Open the same address in the phone's browser to confirm the phone can reach it too.");

console.log(`\n${failures} failed, ${warnings} warning${warnings === 1 ? "" : "s"}.`);
// Not process.exit(): on Windows that can abort mid-cleanup right after a network call and report a garbage exit code.
process.exitCode = failures ? 1 : 0;
