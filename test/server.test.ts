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
        "validate_shape",
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

  it("patches and regenerates the same model instead of creating copies", async () => {
    const created = await client.callTool({
      name: "create_model",
      arguments: {
        name: "Editable",
        shape: { kind: "box", size: [10, 10, 10], center: true },
      },
    });
    const first = (created.structuredContent as {
      activeModel: { id: string; revision: number };
    }).activeModel;
    const patched = await client.callTool({
      name: "update_model",
      arguments: {
        modelId: first.id,
        expectedRevision: first.revision,
        patches: [{ op: "replace", path: "/shape/size/0", value: 20 }],
      },
    });
    const patchPayload = patched.structuredContent as {
      models: unknown[];
      activeModel: { id: string; revision: number; shape: { size: number[] } };
      mesh: { volume: number };
    };
    expect(patchPayload.models).toHaveLength(1);
    expect(patchPayload.activeModel).toMatchObject({
      id: first.id,
      revision: 2,
      shape: { size: [20, 10, 10] },
    });
    expect(patchPayload.mesh.volume).toBeCloseTo(2000, 5);

    const regenerated = await client.callTool({
      name: "generate_model",
      arguments: {
        modelId: first.id,
        expectedRevision: 2,
        template: "gear",
        parameters: { teeth: 12 },
      },
    });
    const regeneratedPayload = regenerated.structuredContent as {
      models: unknown[];
      activeModel: { id: string; revision: number };
    };
    expect(regeneratedPayload.models).toHaveLength(1);
    expect(regeneratedPayload.activeModel).toMatchObject({ id: first.id, revision: 3 });
  });

  it("validates draft shapes and deletes with revision protection", async () => {
    const validation = await client.callTool({
      name: "validate_shape",
      arguments: {
        shape: {
          kind: "extrude",
          points: [
            [0, 0],
            [10, 10],
            [0, 10],
            [10, 0],
          ],
          height: 5,
        },
      },
    });
    expect(validation.structuredContent).toMatchObject({
      valid: false,
      errors: expect.arrayContaining([
        expect.objectContaining({ code: "polygon_self_intersection" }),
      ]),
    });

    const created = await client.callTool({
      name: "create_model",
      arguments: {
        name: "Disposable",
        shape: { kind: "sphere", radius: 5 },
      },
    });
    const model = (created.structuredContent as {
      activeModel: { id: string; revision: number };
    }).activeModel;
    const stale = await client.callTool({
      name: "delete_model",
      arguments: { modelId: model.id, expectedRevision: model.revision + 1 },
    });
    expect(stale.isError).toBe(true);

    const deleted = await client.callTool({
      name: "delete_model",
      arguments: { modelId: model.id, expectedRevision: model.revision },
    });
    expect(deleted.structuredContent).toMatchObject({
      models: [],
      activeModel: null,
      deletedModel: { id: model.id },
    });
  });
});
