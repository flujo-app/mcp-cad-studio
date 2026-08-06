// Spawn the npm CLI in a way that also works on Windows.
//
// Node refuses to spawn `.cmd`/`.bat` shims without a shell (the CVE-2024-27980
// fix), so `spawnSync("npm.cmd", ...)` fails with EINVAL. That failure is silent
// when a caller only inspects `status`, which is exactly how an earlier version of
// the publish script concluded "not logged in" while npm was perfectly happy.
import { spawnSync } from "node:child_process";

export function npmSpawn(args, options = {}) {
  if (process.platform !== "win32") return spawnSync("npm", args, options);
  const commandLine = ["npm", ...args].map(quoteForCmd).join(" ");
  return spawnSync(commandLine, { ...options, shell: true });
}

// cmd.exe splits on whitespace and treats these characters as operators, so quote
// any argument containing them (paths with spaces, scoped names, URLs).
export function quoteForCmd(value) {
  return /[\s"&()<>^|]/.test(value) ? `"${String(value).replace(/"/g, '\\"')}"` : value;
}
