import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCadStudioServer, STUDIO_RESOURCE_URI } from "../src/server.js";
import { CadStore } from "../src/store.js";

describe("MCP server", () => {
  let client: Client;
  let close: () => Promise<void>;

  beforeEach(async () => {
    const server = await createCadStudioServer({
      store: new CadStore(null),
      widgetHtml: "<!doctype html><canvas id=\"viewport\"></canvas>",
    });
    client = new Client({ name: "test-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    close = async () => {
      await client.close();
      await server.close();
    };
  });

  afterEach(async () => close());

  it("advertises the complete CAD tool surface and MCP App link", async () => {
    const result = await client.listTools();
    const names = result.tools.map((tool) => tool.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "studio_ui",
        "list_models",
        "load_model",
        "create_model",
        "generate_model",
        "update_model",
        "transform_model",
        "boolean_models",
        "duplicate_model",
        "delete_model",
        "import_model",
        "export_model",
      ]),
    );
    const studio = result.tools.find((tool) => tool.name === "studio_ui");
    expect(studio?._meta?.ui).toEqual({ resourceUri: STUDIO_RESOURCE_URI });

    const resource = await client.readResource({ uri: STUDIO_RESOURCE_URI });
    expect(resource.contents[0]?.mimeType).toBe("text/html;profile=mcp-app");
    expect(resource.contents[0] && "text" in resource.contents[0]
      ? resource.contents[0].text
      : "").toContain("viewport");
  });

  it("creates, edits, loads, and exports a model through tools", async () => {
    const created = await client.callTool({
      name: "create_model",
      arguments: {
        name: "Tool cube",
        color: "#6ee7b7",
        shape: { kind: "box", size: [10, 10, 10], center: true },
      },
    });
    const createdPayload = created.structuredContent as {
      activeModel: { id: string; revision: number };
      mesh: { volume: number };
    };
    expect(createdPayload.mesh.volume).toBeCloseTo(1000, 5);

    const updated = await client.callTool({
      name: "update_model",
      arguments: {
        modelId: createdPayload.activeModel.id,
        expectedRevision: createdPayload.activeModel.revision,
        shape: { kind: "sphere", radius: 5 },
      },
    });
    expect(
      (updated.structuredContent as { activeModel: { revision: number } }).activeModel
        .revision,
    ).toBe(2);

    const exported = await client.callTool({
      name: "export_model",
      arguments: { modelId: createdPayload.activeModel.id, format: "obj" },
    });
    const exportPayload = exported.structuredContent as { filename: string; data: string };
    expect(exportPayload.filename).toBe("tool-cube.obj");
    expect(exportPayload.data).toContain("\nv ");
    expect(exportPayload.data).toContain("\nf ");
  });
});
