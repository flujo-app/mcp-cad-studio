// Propagates the package.json version into the sources that hard-code it.
//
// Runs automatically as npm's "version" lifecycle script, so
// `npm version patch|minor|<x.y.z>` keeps every occurrence in sync, and runs
// with --check as part of `npm run check`, so a drifted version fails the build
// instead of shipping a package that misreports its own version over MCP.
//
// A pattern that no longer matches is a hard error: silently skipping it would
// reintroduce exactly the drift this script exists to prevent.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const { version } = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const checkOnly = process.argv.includes("--check");

// Every literal below is something the package claims about itself: the MCP
// server identity and the MCP App (widget) client identity. Each pattern must
// expose exactly two capture groups so "$1<version>$2" rebuilds the line.
const targets = [
  { file: "src/server.ts", pattern: /(\{ name: "mcp-cad-studio", version: ")\d+\.\d+\.\d+(")/ },
  { file: "src/widget/app.ts", pattern: /(\{ name: "mcp-cad-studio-view", version: ")\d+\.\d+\.\d+(")/ },
];

let failed = false;
let changed = 0;

for (const { file, pattern } of targets) {
  const absolute = path.join(root, file);
  const content = readFileSync(absolute, "utf8");
  if (!pattern.test(content)) {
    console.error(`sync-version: version pattern not found in ${file}`);
    console.error(`  ${pattern}`);
    failed = true;
    continue;
  }
  const updated = content.replace(pattern, `$1${version}$2`);
  if (updated === content) continue;
  if (checkOnly) {
    console.error(`sync-version: ${file} does not report ${version}`);
    failed = true;
    continue;
  }
  writeFileSync(absolute, updated);
  console.log(`sync-version: ${file} -> ${version}`);
  changed += 1;
}

// server.json repeats the version twice and the MCP Registry rejects a mismatch
// with package.json, so it is synced structurally instead of by regex. Only a
// real value drift rewrites the file, so CRLF checkouts never look "dirty".
const serverJsonPath = path.join(root, "server.json");
const serverJsonRaw = readFileSync(serverJsonPath, "utf8");
const serverJson = JSON.parse(serverJsonRaw);
const npmEntries = (serverJson.packages ?? []).filter((entry) => entry.registryType === "npm");
if (serverJson.version !== version || npmEntries.some((entry) => entry.version !== version)) {
  if (checkOnly) {
    console.error(`sync-version: server.json does not report ${version}`);
    failed = true;
  } else {
    serverJson.version = version;
    for (const entry of npmEntries) entry.version = version;
    const eol = serverJsonRaw.includes("\r\n") ? "\r\n" : "\n";
    writeFileSync(serverJsonPath, JSON.stringify(serverJson, null, 2).replace(/\n/g, eol) + eol);
    console.log(`sync-version: server.json -> ${version}`);
    changed += 1;
  }
}

if (failed) {
  console.error(
    checkOnly
      ? "sync-version: run `npm run sync-version` and commit the result."
      : "sync-version: nothing was written; fix the patterns above.",
  );
  process.exit(1);
}

console.log(
  checkOnly
    ? `sync-version: every version literal matches ${version}.`
    : `sync-version: ${changed} file(s) updated to ${version}.`,
);
