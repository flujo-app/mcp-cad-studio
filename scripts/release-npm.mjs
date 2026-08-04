import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";

const npmCliCandidates = [
  process.env.npm_execpath,
  process.env.APPDATA
    ? path.join(
        process.env.APPDATA,
        "npm",
        "node_modules",
        "npm",
        "bin",
        "npm-cli.js",
      )
    : undefined,
  path.join(
    path.dirname(process.execPath),
    "node_modules",
    "npm",
    "bin",
    "npm-cli.js",
  ),
].filter((candidate) => candidate && existsSync(candidate));

const npmCli = npmCliCandidates[0];
if (!npmCli) {
  throw new Error("Could not locate npm-cli.js for the release command.");
}

function run(args, { allowFailure = false } = {}) {
  const result = spawnSync(process.execPath, [npmCli, ...args], {
    stdio: "inherit",
  });
  if (result.error) {
    throw result.error;
  }
  const status = result.status ?? 1;
  if (status !== 0 && !allowFailure) {
    process.exit(status);
  }
  return status;
}

function readPublishedVersion(packageSpec) {
  const result = spawnSync(
    process.execPath,
    [npmCli, "view", packageSpec, "version", "--json"],
    { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
  );
  if (result.status !== 0) {
    return undefined;
  }
  try {
    const value = JSON.parse(result.stdout);
    return typeof value === "string" ? value : undefined;
  } catch {
    return undefined;
  }
}

if (process.argv.includes("--check")) {
  run(["--version"]);
  process.stdout.write("npm release command self-check passed.\n");
  process.exit(0);
}

const packageJson = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
);
const packageSpec = `${packageJson.name}@${packageJson.version}`;
const alreadyPublished =
  readPublishedVersion(packageSpec) === packageJson.version;

if (!alreadyPublished && run(["whoami"], { allowFailure: true }) !== 0) {
  process.stdout.write(
    "npm authentication is required. Complete the login flow below.\n",
  );
  run(["login"]);
}

run(["run", "check"]);
if (alreadyPublished) {
  process.stdout.write(
    `${packageSpec} is already published; skipping immutable version.\n`,
  );
} else {
  run(["publish", "--access", "public"]);
}
run(["view", packageSpec, "version"]);
