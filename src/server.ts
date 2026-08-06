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
import { applyModelPatches, type ModelPatchOperation } from "./model-patches.js";
import { generatePreset } from "./presets.js";
import { colorSchema, modelNameSchema, shapeSchema } from "./schema.js";
import { CadStore } from "./store.js";
import { validateShape } from "./validation.js";
import type {
  CadModel,
  RenderMesh,
  ShapeNode,
  StudioSnapshot,
  Transform,
} from "./types.js";

export const STUDIO_RESOURCE_URI = "ui://cad-studio/studio.html";

const modelIdSchema = z
  .string()
  .uuid()
  .describe("Saved model ID from list_models, load_model, or a prior tool result");

const expectedRevisionSchema = z
  .number()
  .int()
  .positive()
  .describe("Current revision from load_model; rejects stale edits instead of overwriting them");

const patchPathSchema = z
  .string()
  .startsWith("/")
  .min(2)
  .describe(
    "JSON Pointer into /shape, /name, or /color; for example /shape/size/0 or /shape/children/1/radius",
  );

const modelPatchSchema = z.discriminatedUnion("op", [
  z
    .object({
      op: z.enum(["add", "replace"]),
      path: patchPathSchema,
      value: z.unknown().describe("New JSON value at path"),
    })
    .strict(),
  z
    .object({
      op: z.literal("remove"),
      path: patchPathSchema,
    })
    .strict(),
]);

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
    { name: "mcp-cad-studio", version: "0.2.1" },
    {
      instructions:
        "Use CAD tools to create, inspect, edit, combine, import, export, and delete parametric 3D models. Before changing an existing model, call list_models and load_model, then preserve that modelId: call update_model for direct edits, or generate_model with modelId to regenerate a template in place. Do not create a replacement unless the user asks for a separate model. Prefer update_model.patches for small parameter edits. Call validate_shape before saving complex extrusions or raw meshes. Call studio_ui when the user wants the interactive CAD canvas. Every data tool works without the UI.",
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
        "Load a saved CAD model, including the modelId, current revision, complete editable parametric definition, and render mesh. Call this before update_model or delete_model.",
      inputSchema: { modelId: modelIdSchema },
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
        "Create a separate new CAD model from a declarative parametric shape tree. Do not use this to modify an existing model; load it and call update_model instead. Supports primitives, extrusions, transforms, mesh input, and boolean operations.",
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
          `Created ${model.name} with ${mesh.triangleCount} triangles (model ${model.id}, revision ${model.revision}). For later changes, update this modelId in place with update_model; do not create a replacement.`,
        ),
      };
    },
  );

  server.registerTool(
    "generate_model",
    {
      title: "Generate CAD model",
      description:
        "Generate a built-in parametric template: bracket, pipe, gear, enclosure, or bolt. To revise a previously generated model, pass its modelId and expectedRevision to regenerate it in place. Omit modelId only when the user wants a separate new model.",
      inputSchema: {
        modelId: modelIdSchema
          .describe("Existing model to regenerate in place; omit only to create a new model")
          .optional(),
        expectedRevision: expectedRevisionSchema.optional(),
        name: modelNameSchema
          .describe("Name for a new model, or optional replacement name when regenerating")
          .optional(),
        template: z.enum(["bracket", "pipe", "gear", "enclosure", "bolt"]),
        color: colorSchema
          .describe("Color for a new model, or optional replacement color when regenerating")
          .optional(),
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
    async ({ modelId, expectedRevision, name, template, color, parameters }) => {
      const shape = generatePreset(template, parameters);
      const mesh = await renderShape(shape);
      if (modelId) {
        const current = store.get(modelId);
        const model = await store.update(modelId, {
          name: name ?? current.name,
          color: color ?? current.color,
          shape,
          expectedRevision,
        });
        return {
          structuredContent: await modelPayload(model, store, mesh),
          content: content(
            `Regenerated ${model.name} as a ${template} in place; modelId remains ${model.id}, revision is now ${model.revision}.`,
          ),
        };
      }
      if (!name) {
        throw new Error("name is required when generate_model creates a new model.");
      }
      const model = await store.create({ name, color: color ?? "#60a5fa", shape });
      return {
        structuredContent: await modelPayload(model, store, mesh),
        content: content(
          `Generated ${template} model ${model.name} (${model.id}, revision ${model.revision}) with volume ${mesh.volume.toFixed(2)} mm³. Revise it in place with update_model.`,
        ),
      };
    },
  );

  server.registerTool(
    "update_model",
    {
      title: "Update CAD model",
      description:
        "Modify an existing saved model in place while preserving its modelId. Use patches for small edits (example: replace /shape/size/0), or shape to replace the complete definition. Load the model first and pass its expectedRevision. Never call create_model merely to revise an existing model.",
      inputSchema: {
        modelId: modelIdSchema,
        name: modelNameSchema.describe("Optional replacement name").optional(),
        color: colorSchema.describe("Optional replacement six-digit hex color").optional(),
        shape: shapeSchema
          .describe("Optional complete replacement shape; cannot be combined with patches")
          .optional(),
        patches: z
          .array(modelPatchSchema)
          .min(1)
          .max(64)
          .describe(
            "Targeted edits applied in order to the current model. Use add for a new field/array item, replace for an existing value, and remove for an optional field.",
          )
          .optional(),
        expectedRevision: expectedRevisionSchema.optional(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async ({ modelId, name, color, shape, patches, expectedRevision }) => {
      const current = store.get(modelId);
      if (
        name === undefined &&
        color === undefined &&
        shape === undefined &&
        patches === undefined
      ) {
        throw new Error(
          "update_model needs at least one change: name, color, shape, or patches.",
        );
      }
      if (shape !== undefined && patches !== undefined) {
        throw new Error(
          "Pass either a complete replacement shape or targeted patches, not both.",
        );
      }
      const patched = patches
        ? applyModelPatches(current, patches as ModelPatchOperation[])
        : { name: current.name, color: current.color, shape: current.shape };
      const nextName = modelNameSchema.parse(name ?? patched.name);
      const nextColor = colorSchema.parse(color ?? patched.color);
      const nextShape = shapeSchema.parse(shape ?? patched.shape);
      const mesh = await renderShape(nextShape);
      const model = await store.update(modelId, {
        name: nextName,
        color: nextColor,
        shape: nextShape,
        expectedRevision,
      });
      return {
        structuredContent: await modelPayload(model, store, mesh),
        content: content(
          `Updated ${model.name} in place; modelId remains ${model.id}, revision is now ${model.revision}.`,
        ),
      };
    },
  );

  server.registerTool(
    "validate_shape",
    {
      title: "Validate CAD shape",
      description:
        "Preflight a complete parametric shape without saving it. Reports static polygon/mesh topology errors and warnings, then asks the CAD kernel to verify the solid. Use this before create_model or update_model for complex shapes.",
      inputSchema: { shape: shapeSchema },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async ({ shape }) => {
      const validation = validateShape(shape);
      if (!validation.valid) {
        return {
          structuredContent: { ...validation },
          content: content(
            `Shape is invalid:\n${validation.errors.map((issue) => `- ${issue.path}: ${issue.message}${issue.suggestion ? ` ${issue.suggestion}` : ""}`).join("\n")}`,
          ),
        };
      }
      try {
        const mesh = await renderShape(shape);
        return {
          structuredContent: { ...validation, mesh },
          content: content(
            `Shape is valid: closed manifold solid with ${mesh.triangleCount} triangles and volume ${mesh.volume.toFixed(2)} mm³.${validation.warnings.length ? ` ${validation.warnings.length} warning(s) are included in structuredContent.` : ""}`,
          ),
        };
      } catch (error) {
        const issue = {
          severity: "error" as const,
          code: "kernel_rejection",
          path: "$",
          message: error instanceof Error ? error.message : String(error),
          suggestion:
            "Validate boolean children separately, then simplify coincident or self-intersecting geometry.",
        };
        return {
          structuredContent: {
            valid: false,
            errors: [issue],
            warnings: validation.warnings,
          },
          content: content(`Shape is invalid: ${issue.message}`),
        };
      }
    },
  );

  server.registerTool(
    "transform_model",
    {
      title: "Transform CAD model",
      description:
        "Apply an incremental translation, Euler rotation in degrees, or scale to a CAD model.",
      inputSchema: {
        modelId: modelIdSchema,
        translation: z.tuple([z.number(), z.number(), z.number()]).optional(),
        rotation: z.tuple([z.number(), z.number(), z.number()]).optional(),
        scale: z
          .tuple([
            z.number().refine((entry) => entry !== 0),
            z.number().refine((entry) => entry !== 0),
            z.number().refine((entry) => entry !== 0),
          ])
          .optional(),
        expectedRevision: expectedRevisionSchema.optional(),
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
      description:
        "Permanently delete one saved CAD model. Call list_models or load_model first to identify the exact modelId, and pass expectedRevision when available to avoid deleting a newer edit.",
      inputSchema: {
        modelId: modelIdSchema,
        expectedRevision: expectedRevisionSchema.optional(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: false,
      },
    },
    async ({ modelId, expectedRevision }) => {
      const deleted = await store.delete(modelId, expectedRevision);
      const nextSummary = store.list()[0];
      const next = nextSummary ? store.get(nextSummary.id) : null;
      return {
        structuredContent: next
          ? { ...(await modelPayload(next, store)), deletedModel: summary(deleted) }
          : {
              models: store.list(),
              deletedModel: summary(deleted),
              activeModel: null,
              mesh: null,
            },
        content: content(
          `Deleted ${deleted.name} (${deleted.id}).${next ? ` Selected remaining model ${next.name}.` : " The studio is now empty."}`,
        ),
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
