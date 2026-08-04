import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import type { Server as HttpServer } from "node:http";
import type { Server as HttpsServer } from "node:https";
import type { RequestListener } from "node:http";
import { readFile } from "node:fs/promises";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { generate } from "selfsigned";
import { createCadStudioServer } from "./server.js";
import type { CadStore } from "./store.js";

export interface NetworkServerOptions {
  store: CadStore;
  host: string;
  port: number;
  https: boolean;
  tlsCert?: string;
  tlsKey?: string;
  widgetHtml?: string;
}

export interface RunningNetworkServer {
  server: HttpServer | HttpsServer;
  url: string;
  selfSigned: boolean;
}

async function tlsOptions(options: NetworkServerOptions) {
  if (!options.https) return null;
  if ((options.tlsCert && !options.tlsKey) || (!options.tlsCert && options.tlsKey)) {
    throw new Error("--tls-cert and --tls-key must be provided together");
  }
  if (options.tlsCert && options.tlsKey) {
    return {
      key: await readFile(options.tlsKey, "utf8"),
      cert: await readFile(options.tlsCert, "utf8"),
      selfSigned: false,
    };
  }
  const certificate = await generate(
    [{ name: "commonName", value: "localhost" }],
    {
      algorithm: "sha256",
      keyType: "ec",
      curve: "P-256",
      extensions: [
        { name: "basicConstraints", cA: false },
        { name: "keyUsage", digitalSignature: true, keyEncipherment: true },
        { name: "extKeyUsage", serverAuth: true },
        {
          name: "subjectAltName",
          altNames: [
            { type: 2, value: "localhost" },
            { type: 7, ip: "127.0.0.1" },
            { type: 7, ip: "::1" },
          ],
        },
      ],
    },
  );
  return { key: certificate.private, cert: certificate.cert, selfSigned: true };
}

export async function startNetworkServer(
  options: NetworkServerOptions,
): Promise<RunningNetworkServer> {
  await options.store.ready();
  const tls = await tlsOptions(options);
  const requestHandler: RequestListener = async (
    request,
    response,
  ) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Cache-Control", "no-store");

    if (url.pathname === "/health" && request.method === "GET") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({
          status: "ok",
          name: "mcp-cad-studio",
          transport: options.https ? "https" : "http",
        }),
      );
      return;
    }

    if (url.pathname !== "/mcp") {
      response.writeHead(404, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: "Not found" }));
      return;
    }

    if (request.method === "OPTIONS") {
      response.writeHead(204, {
        Allow: "POST, OPTIONS",
        "Access-Control-Allow-Headers": "content-type, mcp-protocol-version",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
      });
      response.end();
      return;
    }

    if (request.method !== "POST") {
      response.writeHead(405, {
        Allow: "POST, OPTIONS",
        "Content-Type": "application/json",
      });
      response.end(
        JSON.stringify({
          jsonrpc: "2.0",
          error: { code: -32000, message: "Method not allowed" },
          id: null,
        }),
      );
      return;
    }

    const declaredLength = Number(request.headers["content-length"] ?? 0);
    if (declaredLength > 30 * 1024 * 1024) {
      response.writeHead(413, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: "Request body too large" }));
      return;
    }

    const mcp = await createCadStudioServer({
      store: options.store,
      widgetHtml: options.widgetHtml,
    });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    try {
      await mcp.connect(transport);
      await transport.handleRequest(request, response);
    } catch (error) {
      process.stderr.write(
        `[cad-studio] HTTP request failed: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      if (!response.headersSent) {
        response.writeHead(500, { "Content-Type": "application/json" });
        response.end(
          JSON.stringify({
            jsonrpc: "2.0",
            error: { code: -32603, message: "Internal server error" },
            id: null,
          }),
        );
      }
    } finally {
      await transport.close();
      await mcp.close();
    }
  };

  const server = tls
    ? createHttpsServer({ key: tls.key, cert: tls.cert }, requestHandler)
    : createHttpServer(requestHandler);

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : options.port;
  const displayHost =
    options.host === "0.0.0.0" || options.host === "::" ? "localhost" : options.host;
  return {
    server,
    url: `${options.https ? "https" : "http"}://${displayHost}:${port}/mcp`,
    selfSigned: tls?.selfSigned ?? false,
  };
}
