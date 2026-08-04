import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, it } from "vitest";
import { startNetworkServer, type RunningNetworkServer } from "../src/http.js";
import { CadStore } from "../src/store.js";

describe("streamable HTTP transport", () => {
  let running: RunningNetworkServer | undefined;
  afterEach(async () => {
    if (running) await new Promise<void>((resolve) => running!.server.close(() => resolve()));
  });

  it("serves health and MCP requests", async () => {
    running = await startNetworkServer({
      store: new CadStore(null),
      host: "127.0.0.1",
      port: 0,
      https: false,
      widgetHtml: "<!doctype html><canvas id=\"viewport\"></canvas>",
    });
    const health = await fetch(running.url.replace(/\/mcp$/, "/health"));
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ status: "ok", transport: "http" });

    const client = new Client({ name: "http-test", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(running.url)));
    const tools = await client.listTools();
    expect(tools.tools.some((tool) => tool.name === "studio_ui")).toBe(true);
    await client.close();
  });
});
