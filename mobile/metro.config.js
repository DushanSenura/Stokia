// Metro config for the Stokia phone app.
//
// The phone app shares the web project's PURE business code (calculations, count entry, dates, formatting, translations, the offline
// queue rules, permissions) instead of copying it, so the rules cannot drift between web and phone. That code lives in ../src and
// is imported through the `@/` alias (see tsconfig.json). Metro must therefore watch ../src.
//
// Those shared files import three packages (decimal.js, date-fns, @date-fns/tz). They are pinned below to THIS project's copy, so
// there is exactly one copy of each in the app, and it resolves the same way on a developer's machine (where the web project's
// node_modules also exists above this folder) and in CI (where it does not).
const path = require("node:path");
const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname);
const shared = path.resolve(__dirname, "../src");
const SHARED_PACKAGES = new Set(["decimal.js", "date-fns", "@date-fns/tz"]);
const ownPackageJson = path.join(__dirname, "package.json");

config.watchFolders = [...(config.watchFolders ?? []), shared];
config.resolver.nodeModulesPaths = [path.resolve(__dirname, "node_modules")];
config.resolver.resolveRequest = (context, moduleName, platform) => {
  const name = moduleName.split("/").slice(0, moduleName.startsWith("@") ? 2 : 1).join("/");
  const origin = SHARED_PACKAGES.has(name) ? ownPackageJson : context.originModulePath;
  return context.resolveRequest({ ...context, originModulePath: origin }, moduleName, platform);
};

module.exports = config;
