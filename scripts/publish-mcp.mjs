// Publish this server's metadata to the official MCP Registry.
//
// Usage:
//   npm run mcp:publish                       # validate, log in if needed, publish
//   npm run mcp:validate                      # validate only, never authenticate
//   npm run mcp:publish -- --login github-oidc
//   npm run mcp:publish -- --login dns --domain example.com --private-key <hex>
//   npm run mcp:publish -- --force            # re-publish a version already listed
//
// The registry only stores metadata, so the npm package must be live first
// (`npm run release`). This script therefore refuses to publish until
// `<identifier>@<version>` is on npm AND its published package.json carries the
// `mcpName` the registry uses to prove the package belongs to this server - that
// mismatch is the usual cause of "Registry validation failed for package".
// Under --dry-run those two checks only warn, so server.json can be validated
// before the matching npm version exists.
//
// Like `npm run release`, authentication happens IN THIS terminal: the GitHub
// device-code flow prints a code, you enter it in the browser, and the publish
// continues here. No second terminal, no manual token juggling.
//
// GitHub auth only grants the namespace of the account you actually authorize
// with (io.github.<login>/*, plus orgs you belong to), and the registry JWT it
// mints lives ~5 minutes. Publishing a name outside that namespace fails with 403
// forever, so the token's `permissions` claim is checked BEFORE uploading and a
// permission error is never retried as if it were an expired token - otherwise the
// script silently restarts the device flow and looks like it hangs at
// "Waiting for authorization..." with a fresh code nobody knows they must enter.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { npmSpawn } from "./lib/npm-spawn.mjs";

const DEFAULT_REGISTRY = "https://registry.modelcontextprotocol.io";
// The publisher is a credentialed binary, so it is verified against digests
// recorded here rather than whatever the release page serves today. Digests come
// from registry_<version>_checksums.txt.
const PUBLISHER_VERSION = "1.8.0";
const PUBLISHER_TARGETS = {
  "win32-x64": { asset: "mcp-publisher_windows_amd64.tar.gz", sha256: "697df4aaf7941ad6fbac9ebc48bd23ff87a3131ae7bb6ee0543cb857d8029939" },
  "win32-arm64": { asset: "mcp-publisher_windows_arm64.tar.gz", sha256: "21377f392433ec46ec4b5623a1bf72ba9e85b7849319a01f4768ab465b92fad2" },
  "linux-x64": { asset: "mcp-publisher_linux_amd64.tar.gz", sha256: "1370446bbe74d562608e8005a6ccce02d146a661fbd78674e11cc70b9618d6cf" },
  "linux-arm64": { asset: "mcp-publisher_linux_arm64.tar.gz", sha256: "c978982c60e1b4903a976de090f04dc4fac4a320daa50704fcad2dbc93433d62" },
  "darwin-x64": { asset: "mcp-publisher_darwin_amd64.tar.gz", sha256: "5350f756e8408d0e22802b7f384af941448358b503eb1e1772979a61b9b99fde" },
  "darwin-arm64": { asset: "mcp-publisher_darwin_arm64.tar.gz", sha256: "e74f8846c3b5d0428cfeae3f9f520bbf9031d18e68224108c3760d60b6aaf2e0" },
};
const LOGIN_METHODS = ["github", "github-oidc", "dns", "http", "none"];
// Passed straight through to `mcp-publisher login`; kept here so a typo fails
// with a useful message instead of an opaque CLI usage dump.
const LOGIN_PASSTHROUGH_FLAGS = ["--domain", "--private-key", "--kv-vault", "--kv-key-name", "--kms-resource", "--signer-type", "--algorithm", "--token"];

const argv = process.argv.slice(2);
const dryRun = takeFlag("--dry-run");
const force = takeFlag("--force");
const noLogin = takeFlag("--no-login");
const forceLogin = takeFlag("--relogin");
const registryUrl = (takeOption("--registry") ?? DEFAULT_REGISTRY).replace(/\/+$/, "");
const loginMethod = takeOption("--login") ?? "github";
const serverJsonArg = takeOption("--server-json");
if (!LOGIN_METHODS.includes(loginMethod)) {
  throw new Error(`Unknown --login method ${JSON.stringify(loginMethod)}. Supported: ${LOGIN_METHODS.join(", ")}`);
}
const loginExtras = collectLoginExtras();
const unknown = argv.filter((value) => value.startsWith("--"));
if (unknown.length > 0) throw new Error(`Unknown option(s): ${unknown.join(", ")}`);

const projectRoot = path.resolve(process.cwd());
const serverJsonPath = path.resolve(projectRoot, serverJsonArg ?? "server.json");
const packageJson = JSON.parse(await readFile(path.join(projectRoot, "package.json"), "utf8"));
const serverJson = JSON.parse(await readFile(serverJsonPath, "utf8"));

const serverName = serverJson.name;
const version = packageJson.version;
console.log(`Publishing ${serverName}@${serverJson.version} to ${registryUrl}`);
console.log(`Metadata: ${serverJsonPath}`);
if (dryRun) console.log("DRY RUN - validation only, nothing is published\n");

verifyMetadata();
const npmPackages = (serverJson.packages ?? []).filter((entry) => entry.registryType === "npm");
for (const entry of npmPackages) verifyPublishedOnNpm(entry);
await verifyIcons();

// Idempotent: a re-run after a partial release should not need manual
// bookkeeping, and re-publishing an existing version is rejected by the registry
// anyway (versions are immutable).
const listedVersions = await fetchPublishedVersions();
if (listedVersions.includes(version) && !force) {
  console.log(`\n${serverName}@${version} is already in the registry. Nothing to do (use --force to try anyway).`);
  process.exit(0);
}
if (listedVersions.length > 0) {
  console.log(`  registry currently lists: ${listedVersions.slice(-5).join(", ")}`);
}

const publisher = await ensurePublisher();

// `validate` hits the registry's validation endpoint without any credentials, so
// a malformed server.json fails before a browser window is ever opened.
console.log("\nValidating server.json against the registry ...");
const validation = runPublisher(publisher, ["validate", serverJsonPath], { stdio: "inherit" });
if (validation.status !== 0) throw new Error("mcp-publisher validate failed; fix server.json before publishing");

if (dryRun) {
  console.log("\nDry run complete. Re-run without --dry-run to authenticate and publish.");
  process.exit(0);
}

await ensureLogin(publisher);

console.log(`\nUploading ${serverName}@${version} ...`);
let result = runPublisher(publisher, ["publish", serverJsonPath], { encoding: "utf8" });
process.stdout.write(result.stdout ?? "");
process.stderr.write(result.stderr ?? "");
// A 403 means the authenticated identity may never publish this name. Logging in
// again cannot change that, so fail loudly instead of restarting the device flow.
if (result.status !== 0 && isPermissionFailure(result)) {
  throw new Error(await permissionErrorMessage());
}
// A cached token can expire between the check above and the upload; one silent
// re-login is friendlier than making the user work out what "Invalid or expired
// Registry JWT token" means.
if (result.status !== 0 && isAuthFailure(result) && !noLogin) {
  console.log("\nRegistry rejected the saved token (expired). Re-authenticating - a NEW device code follows, the old one is dead.");
  await login(publisher);
  result = runPublisher(publisher, ["publish", serverJsonPath], { encoding: "utf8" });
  process.stdout.write(result.stdout ?? "");
  process.stderr.write(result.stderr ?? "");
  if (result.status !== 0 && isPermissionFailure(result)) {
    throw new Error(await permissionErrorMessage());
  }
}
if (result.status !== 0) {
  throw new Error(
    `mcp-publisher publish failed (exit ${result.status ?? "unknown"}).\n` +
      "Common causes:\n" +
      `  - the npm package for ${version} is not visible to the registry yet (retry in a minute)\n` +
      `  - the authenticated identity may not publish ${serverName} (GitHub auth requires an io.github.<user>/ prefix)\n` +
      "  - this version already exists in the registry (versions are immutable)",
  );
}

console.log(`Published ${serverName}@${version} to ${registryUrl}`);
console.log(`Verify: curl "${registryUrl}/v0.1/servers?search=${encodeURIComponent(serverName)}"`);

function verifyMetadata() {
  const problems = [];
  // The registry proves ownership of an npm package by comparing server.json's
  // name with the mcpName inside the published package, so these must agree.
  if (packageJson.mcpName !== serverName) {
    problems.push(`package.json mcpName ${JSON.stringify(packageJson.mcpName)} != server.json name ${JSON.stringify(serverName)}`);
  }
  if (serverJson.version !== version) {
    problems.push(`server.json version ${JSON.stringify(serverJson.version)} != package.json version ${JSON.stringify(version)}`);
  }
  if (!Array.isArray(serverJson.packages) || serverJson.packages.length === 0) {
    problems.push("server.json declares no packages");
  }
  for (const entry of serverJson.packages ?? []) {
    if (entry.registryType !== "npm") continue;
    if (entry.identifier !== packageJson.name) {
      problems.push(`server.json npm identifier ${JSON.stringify(entry.identifier)} != package.json name ${JSON.stringify(packageJson.name)}`);
    }
    if (entry.version !== version) {
      problems.push(`server.json npm package version ${JSON.stringify(entry.version)} != ${JSON.stringify(version)}`);
    }
  }
  // GitHub auth only grants the io.github.<user>/ namespace; catching it here
  // avoids a confusing 403 after the device-code dance.
  if (loginMethod.startsWith("github") && !serverName.startsWith("io.github.")) {
    problems.push(`GitHub authentication cannot publish ${JSON.stringify(serverName)}; the name must start with "io.github.<user>/"`);
  }
  if (problems.length > 0) {
    throw new Error(`server.json and package.json disagree:\n${problems.map((line) => `  - ${line}`).join("\n")}`);
  }
  console.log(`  metadata OK (npm package ${packageJson.name}@${version})`);
}

// Under --dry-run these are reported as warnings: validating server.json before
// the matching npm version exists is a legitimate (and common) thing to do.
// The registry validates that icons are well-formed URLs but never fetches them,
// so a logo committed but not yet pushed - or a renamed default branch - would
// publish a permanently broken image into an immutable version. Fetch them here.
async function verifyIcons() {
  const icons = serverJson.icons ?? [];
  if (icons.length === 0) {
    console.log("  no icons declared (the registry will show a placeholder)");
    return;
  }
  for (const icon of icons) {
    if (!icon.src?.startsWith("https://")) {
      throw new Error(`Icon src must be an HTTPS URL: ${JSON.stringify(icon.src)}`);
    }
    const response = await fetch(icon.src, { redirect: "follow" }).catch((error) => {
      throw new Error(`Could not fetch icon ${icon.src}: ${error.message}`);
    });
    if (!response.ok) {
      const hint = response.status === 404
        ? "\n  A 404 usually means the icon is committed locally but not pushed to the default branch yet."
        : "";
      const message = `Icon ${icon.src} is not reachable (HTTP ${response.status}).${hint}`;
      if (dryRun) {
        console.warn(`  warning: ${message}`);
        continue;
      }
      throw new Error(message);
    }
    const served = (response.headers.get("content-type") ?? "").split(";")[0].trim();
    if (icon.mimeType && served && served !== icon.mimeType) {
      throw new Error(`Icon ${icon.src} is served as ${served} but server.json declares ${icon.mimeType}`);
    }
    console.log(`  icon OK (${icon.src} -> ${served || "reachable"})`);
  }
}

function verifyPublishedOnNpm(entry) {
  const spec = `${entry.identifier}@${entry.version}`;
  const published = npmView(spec, "version");
  if (published !== entry.version) {
    return report(
      `${spec} is not on npm yet (npm view reported ${JSON.stringify(published ?? "nothing")}).\n` +
        "The registry stores metadata only and validates the package, so publish to npm first:\n" +
        "  npm run release",
    );
  }
  // Verified against the PUBLISHED tarball, not the working tree: editing
  // package.json locally does not change what the registry can see.
  const publishedMcpName = npmView(spec, "mcpName");
  if (publishedMcpName !== serverName) {
    return report(
      `Published ${spec} declares mcpName ${JSON.stringify(publishedMcpName ?? "nothing")}, but this server is ${JSON.stringify(serverName)}.\n` +
        "The registry rejects packages whose mcpName does not match; publish an npm version that carries the right mcpName.",
    );
  }
  console.log(`  npm OK (${spec} declares mcpName ${publishedMcpName})`);
}

function report(message) {
  if (!dryRun) throw new Error(message);
  console.warn(`  warning: ${message}`);
}

function npmView(spec, field) {
  const result = npmSpawn(["view", spec, field, "--registry", "https://registry.npmjs.org"], { encoding: "utf8" });
  if (result.status !== 0) return undefined;
  const value = result.stdout.trim();
  return value === "" ? undefined : value;
}

async function fetchPublishedVersions() {
  const url = `${registryUrl}/v0.1/servers/${encodeURIComponent(serverName)}/versions`;
  const response = await fetch(url).catch((error) => {
    throw new Error(`Could not reach the MCP Registry (${url}): ${error.message}`);
  });
  if (response.status === 404) return [];
  if (!response.ok) {
    console.warn(`  warning: registry lookup returned ${response.status}; skipping the already-published check`);
    return [];
  }
  const body = await response.json();
  return (body.servers ?? []).map((item) => item.server?.version).filter((value) => typeof value === "string");
}

// Install the pinned publisher under .tools/ (git-ignored) so the script works on
// a clean checkout without Homebrew, curl pipelines or a global Go install.
async function ensurePublisher() {
  const override = process.env.MCP_PUBLISHER_BIN;
  if (override) {
    console.log(`  using MCP_PUBLISHER_BIN: ${override}`);
    return override;
  }
  const key = `${process.platform}-${process.arch}`;
  const target = PUBLISHER_TARGETS[key];
  if (!target) {
    throw new Error(
      `No pinned mcp-publisher build for ${key}. Supported: ${Object.keys(PUBLISHER_TARGETS).join(", ")}.\n` +
        "Install it yourself and point MCP_PUBLISHER_BIN at the binary.",
    );
  }
  const installDir = path.join(projectRoot, ".tools", "mcp-publisher", PUBLISHER_VERSION);
  const binary = path.join(installDir, process.platform === "win32" ? "mcp-publisher.exe" : "mcp-publisher");
  const stamp = path.join(installDir, "install.json");
  const installed = await readFile(stamp, "utf8").catch(() => undefined);
  if (installed && JSON.parse(installed).sha256 === target.sha256) return binary;

  const url = `https://github.com/modelcontextprotocol/registry/releases/download/v${PUBLISHER_VERSION}/${target.asset}`;
  console.log(`  downloading mcp-publisher ${PUBLISHER_VERSION} (${target.asset}) ...`);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Download failed (${response.status}): ${url}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== target.sha256) {
    throw new Error(`mcp-publisher checksum mismatch: expected ${target.sha256}, got ${actual}`);
  }
  await mkdir(installDir, { recursive: true });
  const archive = path.join(installDir, target.asset);
  await writeFile(archive, bytes);
  extractArchive(archive, installDir);
  if (process.platform !== "win32") await chmod(binary, 0o755);
  await writeFile(stamp, JSON.stringify({ version: PUBLISHER_VERSION, asset: target.asset, sha256: target.sha256, source: url }, null, 2));
  console.log(`  installed ${binary}`);
  return binary;
}

// The system tar (bsdtar on Windows 10+, GNU tar elsewhere) keeps this script
// dependency-free; the archive was already verified against its pinned digest.
function extractArchive(archive, cwd) {
  const result = spawnSync("tar", ["-xzf", archive, "-C", cwd], { stdio: "inherit" });
  if (result.error) {
    throw new Error(`Could not run tar to unpack ${path.basename(archive)}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`tar failed to unpack ${path.basename(archive)} (exit ${result.status ?? "unknown"})`);
  }
}

function runPublisher(binary, args, options = {}) {
  const result = spawnSync(binary, args, { cwd: projectRoot, ...options });
  if (result.error) throw new Error(`Could not run mcp-publisher: ${result.error.message}`);
  return result;
}

async function ensureLogin(binary) {
  if (noLogin) {
    const token = await readSavedToken();
    if (!token) throw new Error("Not authenticated with the MCP Registry and --no-login was passed. Run `mcp-publisher login` first.");
    console.log(`Using saved ${token.method ?? "unknown"} credentials for ${token.registry ?? registryUrl}`);
    await assertCanPublish();
    return;
  }
  if (!forceLogin) {
    const token = await readSavedToken();
    if (token?.valid && sameRegistry(token.registry, registryUrl) && canPublishServer(token)) {
      console.log(`Authenticated with ${registryUrl} (${token.method ?? "saved"} credentials, ${token.minutesLeft} min left)`);
      return;
    }
    // A cached token for the wrong GitHub account can never publish this name;
    // re-run the device flow rather than burn a publish attempt on a certain 403.
    if (token?.valid && !canPublishServer(token)) {
      console.log(`\nSaved credentials (${token.subject ? `GitHub ${token.subject}` : "unknown identity"}) may not publish ${serverName}; re-authenticating.`);
      console.log("  If the browser keeps signing you in as the wrong account, sign out of github.com first or pass --token <PAT>.");
    }
  }
  await login(binary);
  await assertCanPublish();
}

// Checked right after login so the failure is reported before the upload, with the
// identity that was actually authorized rather than an opaque registry 403.
async function assertCanPublish() {
  const token = await readSavedToken();
  if (!token || token.permissions === undefined) return;
  if (canPublishServer(token)) {
    console.log(`  authorized as ${token.subject ?? "unknown"} for ${token.permissions.map((entry) => entry.resource).join(", ")}`);
    return;
  }
  throw new Error(await permissionErrorMessage(token));
}

function canPublishServer(token) {
  if (!token?.permissions) return true; // unknown claims: let the registry decide
  return token.permissions.some((entry) => {
    if (entry.action && entry.action !== "publish") return false;
    const resource = String(entry.resource ?? "");
    if (resource.endsWith("*")) return serverName.startsWith(resource.slice(0, -1));
    return resource === serverName;
  });
}

async function permissionErrorMessage(token) {
  const saved = token ?? (await readSavedToken());
  const identity = saved?.subject ? `GitHub identity "${saved.subject}"` : "the authenticated identity";
  const granted = saved?.permissions?.map((entry) => entry.resource).join(", ") ?? "(unknown)";
  const owner = serverName.startsWith("io.github.") ? serverName.slice("io.github.".length).split("/")[0] : undefined;
  return (
    `${identity} may not publish ${serverName}.\n` +
    `  granted namespaces: ${granted}\n` +
    "  Re-authenticating will NOT help - fix the identity or the name:\n" +
    (owner
      ? `  - authenticate as GitHub user/org "${owner}": run \`npm run mcp:publish -- --relogin\` while signed in to github.com as ${owner},\n` +
        `    or bypass the browser session entirely with a PAT (scopes read:user, read:org):\n` +
        `      $env:MCP_GITHUB_TOKEN="<pat>"; npm run mcp:publish\n`
      : "") +
    `  - or rename the server to a namespace you own (server.json name + package.json mcpName must match, and the npm package must be re-published with the new mcpName)`
  );
}

async function login(binary) {
  if (noLogin) throw new Error("Registry authentication required but --no-login was passed");
  if (loginMethod === "github" && !process.stdin.isTTY && !process.env.MCP_GITHUB_TOKEN) {
    throw new Error(
      "Interactive GitHub login needs a TTY. In CI use `--login github-oidc`, or set MCP_GITHUB_TOKEN, " +
        "or authenticate with `--login dns|http`.",
    );
  }
  console.log(
    [
      "",
      `Authenticating with ${registryUrl} using \`mcp-publisher login ${loginMethod}\`.`,
      ...(loginMethod === "github"
        ? [
            "A device code is printed below - open the link, enter the code, and publishing resumes here.",
            `GitHub authorizes whichever account your browser is signed in as, and that account must own "${serverName.split("/")[0]}".`,
            "Ctrl-C to abort.",
          ]
        : []),
      "",
    ].join("\n"),
  );
  const args = ["login", loginMethod, "--registry", registryUrl, ...loginExtras];
  const result = runPublisher(binary, args, { stdio: "inherit" });
  if (result.status !== 0) throw new Error(`mcp-publisher login ${loginMethod} failed (exit ${result.status ?? "unknown"})`);
  const token = await readSavedToken();
  if (!token) throw new Error("Login reported success but no token was saved; re-run this script to retry");
}

// mcp-publisher stores a short-lived registry JWT in ~/.config/mcp-publisher/token.json
// (older builds used ~/.mcp_publisher_token). Reading it lets a re-run inside the
// token's lifetime skip the device-code flow entirely.
async function readSavedToken() {
  const candidates = [path.join(os.homedir(), ".config", "mcp-publisher", "token.json"), path.join(os.homedir(), ".mcp_publisher_token")];
  for (const candidate of candidates) {
    const raw = await readFile(candidate, "utf8").catch(() => undefined);
    if (!raw) continue;
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    if (!parsed.token) continue;
    const claims = jwtClaims(parsed.token);
    const expiresAt = typeof claims?.exp === "number" ? claims.exp * 1000 : undefined;
    const minutesLeft = expiresAt === undefined ? undefined : Math.floor((expiresAt - Date.now()) / 60000);
    return {
      method: parsed.method,
      registry: parsed.registry,
      subject: claims?.auth_method_sub,
      permissions: Array.isArray(claims?.permissions) ? claims.permissions : undefined,
      // Unknown expiry is treated as usable: a stale token only costs one
      // rejected publish, which is retried after a fresh login.
      valid: expiresAt === undefined || expiresAt - Date.now() > 60_000,
      minutesLeft: minutesLeft ?? "unknown",
    };
  }
  return undefined;
}

function jwtClaims(token) {
  const payload = token.split(".")[1];
  if (!payload) return undefined;
  try {
    return JSON.parse(Buffer.from(payload.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
  } catch {
    return undefined;
  }
}

function sameRegistry(a, b) {
  if (!a) return true;
  return a.replace(/\/+$/, "") === b.replace(/\/+$/, "");
}

// Deliberately narrow: only a token problem a fresh login can actually fix. The
// naive pattern also matches "403" and any mention of "token", so a permanent
// permission error would trigger an endless-looking re-login.
function isAuthFailure(result) {
  const output = publisherOutput(result);
  if (isPermissionFailure(result)) return false;
  return /invalid or expired|expired token|jwt|not authenticated|unauthenticated|unauthorized|\b401\b/.test(output);
}

function isPermissionFailure(result) {
  const output = publisherOutput(result);
  return /\b403\b|forbidden|permission denied|do(?:es)? not have permission|not authorized to publish|namespace/.test(output);
}

function publisherOutput(result) {
  return `${result.stdout ?? ""}${result.stderr ?? ""}`.toLowerCase();
}

function takeFlag(name) {
  const index = argv.indexOf(name);
  if (index === -1) return false;
  argv.splice(index, 1);
  return true;
}

function takeOption(name) {
  const index = argv.indexOf(name);
  if (index === -1) return undefined;
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`${name} requires a value`);
  argv.splice(index, 2);
  return value;
}

function collectLoginExtras() {
  const extras = [];
  for (const flag of LOGIN_PASSTHROUGH_FLAGS) {
    const value = takeOption(flag);
    if (value !== undefined) extras.push(flag, value);
  }
  return extras;
}
