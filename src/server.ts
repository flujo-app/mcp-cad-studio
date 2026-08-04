import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  registerAppResource,
  registerAppTool,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { exportObj, exportStl, renderShape } from "./geometry.js";
import { importModel } from "./importers.js";
import { generatePreset } from "./presets.js";
import { colorSchema, modelNameSchema, shapeSchema } from "./schema.js";
import { CadStore } from "./store.js";
import type {
  CadModel,
  RenderMesh,
  ShapeNode,
  StudioSnapshot,
  Transform,
} from "./types.js";

export const STUDIO_RESOURCE_URI = "ui://cad-studio/studio.html";

export interface CadStudioServerOptions {
  store: CadStore;
  widgetHtml?: string;
}

async function loadWidgetHtml(): Promise<string> {
  const adjacent = new URL("./widget.html", import.meta.url);
  try {
    return await readFile(adjacent, "utf8");
  } catch {
    return readFile(join(process.cwd(), "dist", "widget.html"), "utf8");
  }
}

function content(text: string) {
  return [{ type: "text" as const, text }];
}

function summary(model: CadModel) {
  return {
    id: model.id,
    name: model.name,
    color: model.color,
    revision: model.revision,
    updatedAt: model.updatedAt,
    kind: model.shape.kind,
  };
}

async function modelPayload(model: CadModel, store: CadStore, mesh?: RenderMesh) {
  const rendered = mesh ?? (await renderShape(model.shape));
  return {
    models: store.list(),
    activeModel: model,
    mesh: rendered,
  } satisfies StudioSnapshot;
}

function addVec(
  left: [number, number, number] | undefined,
  right: [number, number, number] | undefined,
  fallback: number,
) {
  return [
    (left?.[0] ?? fallback) + (right?.[0] ?? fallback),
    (left?.[1] ?? fallback) + (right?.[1] ?? fallback),
    (left?.[2] ?? fallback) + (right?.[2] ?? fallback),
  ] as [number, number, number];
}

function multiplyVec(
  left: [number, number, number] | undefined,
  right: [number, number, number] | undefined,
) {
  return [
    (left?.[0] ?? 1) * (right?.[0] ?? 1),
    (left?.[1] ?? 1) * (right?.[1] ?? 1),
    (left?.[2] ?? 1) * (right?.[2] ?? 1),
  ] as [number, number, number];
}

function applyTransform(shape: ShapeNode, next: Transform): ShapeNode {
  const current = shape.transform;
  return {
    ...shape,
    transform: {
      translation: addVec(current?.translation, next.translation, 0),
      rotation: addVec(current?.rotation, next.rotation, 0),
      scale: multiplyVec(current?.scale, next.scale),
    },
  };
}

export async function createCadStudioServer(
  options: CadStudioServerOptions,
): Promise<McpServer> {
  await options.store.ready();
  const widgetHtml = options.widgetHtml ?? (await loadWidgetHtml());
  const { store } = options;
  const server = new McpServer(
    { name: "mcp-cad-studio", version: "0.1.0" },
    {
      instructions:
        "Use CAD tools to create, inspect, edit, combine, import, and export parametric 3D models. Call studio_ui when the user wants the interactive CAD canvas. Every data tool works without the UI.",
    },
  );

  registerAppResource(
    server,
    "CAD Studio",
    STUDIO_RESOURCE_URI,
    {
      description: "Interactive parametric CAD editor and live 3D viewport.",
      _meta: {
        ui: {
          prefersBorder: false,
          csp: { resourceDomains: [], connectDomains: [] },
        },
      },
    },
    async () => ({
      contents: [
        {
          uri: STUDIO_RESOURCE_URI,
          mimeType: RESOURCE_MIME_TYPE,
          text: widgetHtml,
          _meta: {
            ui: {
              prefersBorder: false,
              csp: { resourceDomains: [], connectDomains: [] },
            },
          },
        },
      ],
    }),
  );

  registerAppTool(
    server,
    "studio_ui",
    {
      title: "Open CAD Studio",
      description:
        "Open the interactive CAD Studio. Use this when the user asks to view or work with a model visually.",
      inputSchema: {
        modelId: z.string().uuid().optional().describe("Model to select initially"),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
      _meta: {
        ui: { resourceUri: STUDIO_RESOURCE_URI },
        "openai/outputTemplate": STUDIO_RESOURCE_URI,
        "openai/toolInvocation/invoking": "Opening CAD Studio…",
        "openai/toolInvocation/invoked": "CAD Studio ready",
      },
    },
    async ({ modelId }) => {
      let selected = modelId ? store.get(modelId) : undefined;
      if (!selected) {
        const first = store.list()[0];
        selected = first
          ? store.get(first.id)
          : await store.create({
              name: "Starter block",
              color: "#6ee7b7",
              shape: { kind: "box", size: [40, 30, 18], center: true },
            });
      }
      const snapshot = await modelPayload(selected, store);
      return {
        structuredContent: snapshot,
        content: content(`Opened CAD Studio with ${selected.name}.`),
      };
    },
  );

  server.registerTool(
    "list_models",
    {
      title: "List CAD models",
      description: "List the CAD models currently saved in this studio.",
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async () => {
      const models = store.list();
      return {
        structuredContent: { models },
        content: content(
          models.length === 0
            ? "The CAD studio is empty."
            : `Found ${models.length} CAD model${models.length === 1 ? "" : "s"}.`,
        ),
      };
    },
  );

  server.registerTool(
    "load_model",
    {
      title: "Load CAD model",
      description:
        "Load a saved CAD model, its editable parametric definition, and render mesh.",
      inputSchema: { modelId: z.string().uuid() },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async ({ modelId }) => {
      const model = store.get(modelId);
      return {
        structuredContent: await modelPayload(model, store),
        content: content(
          `Loaded ${model.name} (revision ${model.revision}, ${model.shape.kind}).`,
        ),
      };
    },
  );

  server.registerTool(
    "create_model",
    {
      title: "Create CAD model",
      description:
        "Create a CAD model from a declarative parametric shape tree. Supports primitives, extrusions, transforms, mesh input, and boolean operations.",
      inputSchema: {
        name: modelNameSchema,
        color: colorSchema.default("#6ee7b7"),
        shape: shapeSchema,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async ({ name, color, shape }) => {
      const mesh = await renderShape(shape);
      const model = await store.create({ name, color, shape });
      return {
        structuredContent: await modelPayload(model, store, mesh),
        content: content(
          `Created ${model.name} with ${mesh.triangleCount} triangles (model ${model.id}).`,
        ),
      };
    },
  );

  server.registerTool(
    "generate_model",
    {
      title: "Generate CAD model",
      description:
        "Generate a useful parametric CAD model from a built-in template: bracket, pipe, gear, enclosure, or bolt.",
      inputSchema: {
        name: modelNameSchema,
        template: z.enum(["bracket", "pipe", "gear", "enclosure", "bolt"]),
        color: colorSchema.default("#60a5fa"),
        parameters: z
          .object({
            width: z.number().positive().optional(),
            depth: z.number().positive().optional(),
            height: z.number().positive().optional(),
            thickness: z.number().positive().optional(),
            radius: z.number().positive().optional(),
            holeRadius: z.number().positive().optional(),
            teeth: z.number().int().min(6).max(80).optional(),
          })
          .optional(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async ({ name, template, color, parameters }) => {
      const shape = generatePreset(template, parameters);
      const mesh = await renderShape(shape);
      const model = await store.create({ name, color, shape });
      return {
        structuredContent: await modelPayload(model, store, mesh),
        content: content(
          `Generated ${template} model ${model.name} with volume ${mesh.volume.toFixed(2)} mm³.`,
        ),
      };
    },
  );

  server.registerTool(
    "update_model",
    {
      title: "Update CAD model",
      description:
        "Edit a CAD model by replacing its name, color, or parametric shape definition. Pass expectedRevision to prevent overwriting concurrent edits.",
      inputSchema: {
        modelId: z.string().uuid(),
        name: modelNameSchema.optional(),
        color: colorSchema.optional(),
        shape: shapeSchema.optional(),
        expectedRevision: z.number().int().positive().optional(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async ({ modelId, name, color, shape, expectedRevision }) => {
      const current = store.get(modelId);
      const nextShape = shape ?? current.shape;
      const mesh = await renderShape(nextShape);
      const model = await store.update(modelId, {
        name,
        color,
        shape,
        expectedRevision,
      });
      return {
        structuredContent: await modelPayload(model, store, mesh),
        content: content(`Updated ${model.name} to revision ${model.revision}.`),
      };
    },
  );

  server.registerTool(
    "transform_model",
    {
      title: "Transform CAD model",
      description:
        "Apply an incremental translation, Euler rotation in degrees, or scale to a CAD model.",
      inputSchema: {
        modelId: z.string().uuid(),
        translation: z.tuple([z.number(), z.number(), z.number()]).optional(),
        rotation: z.tuple([z.number(), z.number(), z.number()]).optional(),
        scale: z
          .tuple([
            z.number().refine((entry) => entry !== 0),
            z.number().refine((entry) => entry !== 0),
            z.number().refine((entry) => entry !== 0),
          ])
          .optional(),
        expectedRevision: z.number().int().positive().optional(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async ({ modelId, translation, rotation, scale, expectedRevision }) => {
      const current = store.get(modelId);
      const shape = applyTransform(current.shape, { translation, rotation, scale });
      const mesh = await renderShape(shape);
      const model = await store.update(modelId, { shape, expectedRevision });
      return {
        structuredContent: await modelPayload(model, store, mesh),
        content: content(`Transformed ${model.name}.`),
      };
    },
  );

  server.registerTool(
    "boolean_models",
    {
      title: "Combine CAD models",
      description:
        "Create a new model by union, difference, or intersection of two or more saved models.",
      inputSchema: {
        name: modelNameSchema,
        operation: z.enum(["union", "difference", "intersection"]),
        modelIds: z.array(z.string().uuid()).min(2).max(32),
        color: colorSchema.optional(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async ({ name, operation, modelIds, color }) => {
      const sources = modelIds.map((id) => store.get(id));
      const shape: ShapeNode = {
        kind: operation,
        children: sources.map((model) => model.shape),
      };
      const mesh = await renderShape(shape);
      const model = await store.create({
        name,
        color: color ?? sources[0]?.color ?? "#a78bfa",
        shape,
      });
      return {
        structuredContent: await modelPayload(model, store, mesh),
        content: content(
          `Created ${operation} model ${model.name} from ${sources.length} models.`,
        ),
      };
    },
  );

  server.registerTool(
    "duplicate_model",
    {
      title: "Duplicate CAD model",
      description: "Create an editable copy of a saved CAD model.",
      inputSchema: {
        modelId: z.string().uuid(),
        name: modelNameSchema.optional(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async ({ modelId, name }) => {
      const model = await store.duplicate(modelId, name);
      return {
        structuredContent: await modelPayload(model, store),
        content: content(`Duplicated model as ${model.name} (${model.id}).`),
      };
    },
  );

  server.registerTool(
    "delete_model",
    {
      title: "Delete CAD model",
      description: "Permanently delete a saved CAD model from this studio.",
      inputSchema: { modelId: z.string().uuid() },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: false,
      },
    },
    async ({ modelId }) => {
      const deleted = await store.delete(modelId);
      return {
        structuredContent: {
          models: store.list(),
          deletedModel: summary(deleted),
          activeModel: null,
          mesh: null,
        },
        content: content(`Deleted ${deleted.name}.`),
      };
    },
  );

  server.registerTool(
    "import_model",
    {
      title: "Import CAD model",
      description:
        "Import an STL or OBJ model from text or base64 data and save it in the studio.",
      inputSchema: {
        name: modelNameSchema,
        format: z.enum(["stl", "obj"]),
        data: z.string().min(1),
        encoding: z.enum(["text", "base64"]).default("text"),
        color: colorSchema.default("#f59e0b"),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async ({ name, format, data, encoding, color }) => {
      const shape = importModel(format, data, encoding);
      const mesh = await renderShape(shape);
      const model = await store.create({ name, color, shape });
      return {
        structuredContent: await modelPayload(model, store, mesh),
        content: content(
          `Imported ${model.name} from ${format.toUpperCase()} (${mesh.triangleCount} triangles).`,
        ),
      };
    },
  );

  server.registerTool(
    "export_model",
    {
      title: "Export CAD model",
      description: "Export a saved CAD model as ASCII STL or OBJ data.",
      inputSchema: {
        modelId: z.string().uuid(),
        format: z.enum(["stl", "obj"]),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async ({ modelId, format }) => {
      const model = store.get(modelId);
      const data =
        format === "stl"
          ? await exportStl(model.shape, model.name)
          : await exportObj(model.shape, model.name);
      const filename = `${model.name.replace(/[^a-zA-Z0-9_-]+/g, "-").toLowerCase()}.${format}`;
      return {
        structuredContent: { format, filename, data, model: summary(model) },
        content: content(
          `Exported ${model.name} as ${filename} (${Buffer.byteLength(data)} bytes).`,
        ),
      };
    },
  );

  return server;
}
