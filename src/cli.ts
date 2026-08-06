import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { startNetworkServer } from "./http.js";
import { createCadStudioServer } from "./server.js";
import { CadStore } from "./store.js";

interface CliOptions {
  transport: "stdio" | "http";
  host: string;
  port: number;
  https: boolean;
  tlsCert?: string;
  tlsKey?: string;
  dataFile: string | null;
}

const usage = `MCP CAD Studio

Usage:
  mcp-cad-studio [--stdio]
  mcp-cad-studio --transport http [options]

Options:
  --stdio                  Use stdio transport (default)
  --transport <mode>       stdio, http, or https
  --host <address>         Network bind address (default: 127.0.0.1)
  --port <number>          Network port (default: 8787)
  --https                  Enable TLS for the HTTP transport
  --tls-cert <path>        PEM certificate for HTTPS
  --tls-key <path>         PEM private key for HTTPS
  --data-file <path>       Persistent model database JSON file
  --no-persist             Keep models in memory only
  --help                   Show this help

When --https is used without certificate paths, a bundled self-signed localhost
certificate is generated. Use a trusted certificate or an HTTPS reverse proxy
for remote production deployments.
`;

function valueAfter(args: string[], index: number, option: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${option} needs a value`);
  return value;
}

export function parseCli(args: string[]): CliOptions {
  const options: CliOptions = {
    transport: "stdio",
    host: "127.0.0.1",
    port: 8787,
    https: false,
    dataFile: join(homedir(), ".mcp-cad-studio", "models.json"),
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    switch (arg) {
      case "--help":
      case "-h":
        process.stdout.write(usage);
        process.exit(0);
        break;
      case "--stdio":
        options.transport = "stdio";
        break;
      case "--transport": {
        const mode = valueAfter(args, index, arg);
        index += 1;
        if (mode === "https") {
          options.transport = "http";
          options.https = true;
        } else if (mode === "http" || mode === "stdio") {
          options.transport = mode;
        } else {
          throw new Error("--transport must be stdio, http, or https");
        }
        break;
      }
      case "--host":
        options.host = valueAfter(args, index, arg);
        index += 1;
        break;
      case "--port":
        options.port = Number(valueAfter(args, index, arg));
        index += 1;
        if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535) {
          throw new Error("--port must be an integer from 0 to 65535");
        }
        break;
      case "--https":
        options.https = true;
        options.transport = "http";
        break;
      case "--tls-cert":
        options.tlsCert = resolve(valueAfter(args, index, arg));
        index += 1;
        break;
      case "--tls-key":
        options.tlsKey = resolve(valueAfter(args, index, arg));
        index += 1;
        break;
      case "--data-file":
        options.dataFile = resolve(valueAfter(args, index, arg));
        index += 1;
        break;
      case "--no-persist":
        options.dataFile = null;
        break;
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }
  return options;
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  const options = parseCli(args);
  const store = new CadStore(options.dataFile);

  if (options.transport === "stdio") {
    const server = await createCadStudioServer({ store });
    const transport = new StdioServerTransport();
    await server.connect(transport);
    return;
  }

  const running = await startNetworkServer({
    store,
    host: options.host,
    port: options.port,
    https: options.https,
    tlsCert: options.tlsCert,
    tlsKey: options.tlsKey,
  });
  process.stderr.write(`[cad-studio] MCP endpoint: ${running.url}\n`);
  process.stderr.write(`[cad-studio] Health check: ${running.url.replace(/\/mcp$/, "/health")}\n`);
  if (running.selfSigned) {
    process.stderr.write(
      "[cad-studio] Using an ephemeral self-signed certificate; clients must trust it explicitly.\n",
    );
  }

  const shutdown = () => {
    running.server.close(() => process.exit(0));
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

// dist/cli.js is only ever used as the package's `bin` entry - it is never
// imported as a library (that is dist/index.js), so main() runs unconditionally.
//
// Do NOT reintroduce an `import.meta.url === process.argv[1]` guard here: npm and
// npx install bins as SYMLINKS in node_modules/.bin on Linux and macOS, so
// argv[1] is the symlink while import.meta.url is the real file. Such a guard
// silently skips main(), the process exits 0 without writing to stdout, and MCP
// clients report "MCP error -32000: Connection closed".
main().catch((error) => {
  process.stderr.write(`[cad-studio] ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
