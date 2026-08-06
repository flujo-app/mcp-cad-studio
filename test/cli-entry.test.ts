import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

// Regression test for the bug where `npx mcp-cad-studio --stdio` died instantly on
// Linux/macOS with "MCP error -32000: Connection closed" while working on Windows.
//
// npm/npx expose bins as SYMLINKS in node_modules/.bin on POSIX systems, but as
// .cmd/.ps1 shims that call the real path on Windows. dist/cli.js used to guard
// main() with `resolve(process.argv[1]) === fileURLToPath(import.meta.url)`, which
// can never match through a symlink, so the process exited 0 having written nothing.

const distCli = resolve(dirname(fileURLToPath(import.meta.url)), "..", "dist", "cli.js");

const INITIALIZE = `${JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "cli-entry-test", version: "1.0.0" },
  },
})}\n`;

const temporaryDirectories: string[] = [];

afterAll(() => {
  for (const directory of temporaryDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function initialize(entry: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [entry, "--stdio"], {
      stdio: ["pipe", "pipe", "pipe"],
      // Keep the store out of the developer's real home directory.
      env: (() => {
        const home = mkdtempSync(join(tmpdir(), "cad-home-"));
        temporaryDirectories.push(home);
        return { ...process.env, HOME: home, USERPROFILE: home };
      })(),
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
      // The server stays alive after responding, so stop as soon as we have a frame.
      if (stdout.includes("\n")) child.kill();
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", rejectPromise);
    child.on("close", (code) => resolvePromise({ code, stdout, stderr }));
    child.stdin.end(INITIALIZE);
  });
}

describe.skipIf(!existsSync(distCli))("dist/cli.js entry point", () => {
  it("responds to initialize when started through its real path", async () => {
    const { stdout, stderr } = await initialize(distCli);
    expect(stdout, `stderr was: ${stderr}`).toContain('"serverInfo"');
    expect(stdout).toContain("mcp-cad-studio");
  }, 30_000);

  it("responds to initialize when started through a symlink (npx / node_modules/.bin)", async () => {
    const directory = mkdtempSync(join(tmpdir(), "cad-bin-"));
    temporaryDirectories.push(directory);
    const link = join(directory, "mcp-cad-studio");
    try {
      symlinkSync(distCli, link, "file");
    } catch {
      // Windows without Developer Mode / SeCreateSymbolicLinkPrivilege.
      return;
    }

    const { stdout, stderr } = await initialize(link);
    expect(stdout, `stderr was: ${stderr}`).toContain('"serverInfo"');
    expect(stdout).toContain("mcp-cad-studio");
  }, 30_000);
});
