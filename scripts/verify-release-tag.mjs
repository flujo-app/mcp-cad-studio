// Fail a release before anything is published when the pushed Git tag and the
// version in package.json disagree. npm versions are immutable, so a mismatch
// caught here is trivial to fix and impossible to fix afterwards.
//
// Usage: node scripts/verify-release-tag.mjs v0.2.0
import { readFile } from "node:fs/promises";
import process from "node:process";

const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const actualTag = process.argv[2];
const expectedTag = `v${packageJson.version}`;

if (!actualTag) {
  throw new Error(`No tag was passed. Expected ${JSON.stringify(expectedTag)}.`);
}

if (actualTag !== expectedTag) {
  throw new Error(
    `Release tag ${JSON.stringify(actualTag)} does not match package version ${JSON.stringify(expectedTag)}`,
  );
}

console.log(`Verified release tag ${actualTag}`);
