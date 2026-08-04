#!/usr/bin/env node

// src/server.ts
import { readFile } from "fs/promises";
import { join } from "path";
import {
  registerAppResource,
  registerAppTool,
  RESOURCE_MIME_TYPE
} from "@modelcontextprotocol/ext-apps/server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z as z2 } from "zod";

// src/geometry.ts
import createManifoldModule from "manifold-3d";
var modulePromise;
async function getManifoldModule() {
  modulePromise ??= createManifoldModule().then((module) => {
    module.setup();
    return module;
  });
  return modulePromise;
}
function applyTransform(source, transform2) {
  if (!transform2) return source;
  let result = source;
  const replace = (next) => {
    if (next !== result) result.delete();
    result = next;
  };
  if (transform2.scale) replace(result.scale(transform2.scale));
  if (transform2.rotation) replace(result.rotate(transform2.rotation));
  if (transform2.translation) replace(result.translate(transform2.translation));
  return result;
}
function assertShapeComplexity(shape) {
  let nodes = 0;
  const visit = (node, depth) => {
    nodes += 1;
    if (depth > 24) throw new Error("Shape tree exceeds the maximum depth of 24");
    if (nodes > 256) throw new Error("Shape tree exceeds the maximum of 256 nodes");
    if (node.kind === "union" || node.kind === "difference" || node.kind === "intersection") {
      node.children.forEach((child) => visit(child, depth + 1));
    }
  };
  visit(shape, 0);
}
async function buildNode(shape, module) {
  const { Manifold, Mesh } = module;
  let result;
  switch (shape.kind) {
    case "box":
      result = Manifold.cube(shape.size, shape.center ?? false);
      break;
    case "sphere":
      result = Manifold.sphere(shape.radius, shape.segments ?? 48);
      break;
    case "cylinder":
      result = Manifold.cylinder(
        shape.height,
        shape.radius,
        shape.radius,
        shape.segments ?? 48,
        shape.center ?? false
      );
      break;
    case "cone":
      result = Manifold.cylinder(
        shape.height,
        shape.radiusBottom,
        shape.radiusTop,
        shape.segments ?? 48,
        shape.center ?? false
      );
      break;
    case "extrude":
      result = Manifold.extrude(
        shape.points,
        shape.height,
        Math.max(0, Math.ceil(Math.abs(shape.twist ?? 0) / 15) - 1),
        shape.twist ?? 0,
        shape.scaleTop ?? [1, 1],
        shape.center ?? false
      );
      break;
    case "mesh": {
      if (shape.vertices.length % 3 !== 0 || shape.triangles.length % 3 !== 0) {
        throw new Error("Mesh vertices and triangles must contain complete triples");
      }
      const vertexCount = shape.vertices.length / 3;
      if (shape.triangles.some((index) => index >= vertexCount)) {
        throw new Error("Mesh triangle index is outside the vertex array");
      }
      const mesh = new Mesh({
        numProp: 3,
        vertProperties: Float32Array.from(shape.vertices),
        triVerts: Uint32Array.from(shape.triangles)
      });
      mesh.merge();
      result = Manifold.ofMesh(mesh);
      break;
    }
    case "union":
    case "difference":
    case "intersection": {
      const [first, ...rest] = shape.children;
      if (!first) throw new Error(`${shape.kind} requires at least two children`);
      result = await buildNode(first, module);
      try {
        for (const child of rest) {
          const other = await buildNode(child, module);
          let next;
          try {
            next = shape.kind === "union" ? result.add(other) : shape.kind === "difference" ? result.subtract(other) : result.intersect(other);
          } finally {
            other.delete();
          }
          result.delete();
          result = next;
        }
      } catch (error) {
        result.delete();
        throw error;
      }
      break;
    }
  }
  return applyTransform(result, shape.transform);
}
async function buildSolid(shape) {
  assertShapeComplexity(shape);
  const module = await getManifoldModule();
  const solid = await buildNode(shape, module);
  const status = solid.status();
  if (status !== "NoError") {
    solid.delete();
    throw new Error(`CAD kernel rejected the shape (status ${String(status)})`);
  }
  return solid;
}
async function renderShape(shape) {
  const solid = await buildSolid(shape);
  try {
    const mesh = solid.getMesh();
    const positions = [];
    for (let vertex = 0; vertex < mesh.numVert; vertex += 1) {
      const offset = vertex * mesh.numProp;
      positions.push(
        mesh.vertProperties[offset] ?? 0,
        mesh.vertProperties[offset + 1] ?? 0,
        mesh.vertProperties[offset + 2] ?? 0
      );
    }
    const bounds = solid.boundingBox();
    return {
      positions,
      triangles: Array.from(mesh.triVerts),
      bounds: {
        min: Array.from(bounds.min),
        max: Array.from(bounds.max)
      },
      volume: solid.volume(),
      surfaceArea: solid.surfaceArea(),
      vertexCount: mesh.numVert,
      triangleCount: mesh.numTri
    };
  } finally {
    solid.delete();
  }
}
async function exportObj(shape, name) {
  const mesh = await renderShape(shape);
  const lines = [`# ${name} exported by MCP CAD Studio`];
  for (let index = 0; index < mesh.positions.length; index += 3) {
    lines.push(
      `v ${mesh.positions[index]} ${mesh.positions[index + 1]} ${mesh.positions[index + 2]}`
    );
  }
  for (let index = 0; index < mesh.triangles.length; index += 3) {
    lines.push(
      `f ${(mesh.triangles[index] ?? 0) + 1} ${(mesh.triangles[index + 1] ?? 0) + 1} ${(mesh.triangles[index + 2] ?? 0) + 1}`
    );
  }
  return `${lines.join("\n")}
`;
}
function normal(a, b, c) {
  const ux = b[0] - a[0];
  const uy = b[1] - a[1];
  const uz = b[2] - a[2];
  const vx = c[0] - a[0];
  const vy = c[1] - a[1];
  const vz = c[2] - a[2];
  const nx = uy * vz - uz * vy;
  const ny = uz * vx - ux * vz;
  const nz = ux * vy - uy * vx;
  const length = Math.hypot(nx, ny, nz) || 1;
  return [nx / length, ny / length, nz / length];
}
async function exportStl(shape, name) {
  const mesh = await renderShape(shape);
  const lines = [`solid ${name.replace(/[^a-zA-Z0-9_-]/g, "_")}`];
  const vertex = (index) => {
    const offset = index * 3;
    return [
      mesh.positions[offset] ?? 0,
      mesh.positions[offset + 1] ?? 0,
      mesh.positions[offset + 2] ?? 0
    ];
  };
  for (let index = 0; index < mesh.triangles.length; index += 3) {
    const a = vertex(mesh.triangles[index] ?? 0);
    const b = vertex(mesh.triangles[index + 1] ?? 0);
    const c = vertex(mesh.triangles[index + 2] ?? 0);
    const n = normal(a, b, c);
    lines.push(
      `  facet normal ${n.join(" ")}`,
      "    outer loop",
      `      vertex ${a.join(" ")}`,
      `      vertex ${b.join(" ")}`,
      `      vertex ${c.join(" ")}`,
      "    endloop",
      "  endfacet"
    );
  }
  lines.push("endsolid");
  return `${lines.join("\n")}
`;
}

// src/importers.ts
var MAX_BYTES = 25 * 1024 * 1024;
function decode(data, encoding) {
  const bytes = encoding === "base64" ? Uint8Array.from(Buffer.from(data, "base64")) : new TextEncoder().encode(data);
  if (bytes.byteLength > MAX_BYTES) {
    throw new Error("Imported model exceeds the 25 MiB limit");
  }
  return bytes;
}
function meshShape(vertices, triangles) {
  if (vertices.length < 9 || triangles.length < 3) {
    throw new Error("No triangles were found in the imported model");
  }
  return { kind: "mesh", vertices, triangles };
}
function parseObj(text) {
  const sourceVertices = [];
  const vertices = [];
  const triangles = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const parts = line.split(/\s+/);
    if (parts[0] === "v" && parts.length >= 4) {
      const point = parts.slice(1, 4).map(Number);
      if (point.some((entry) => !Number.isFinite(entry))) {
        throw new Error("OBJ contains a non-numeric vertex");
      }
      sourceVertices.push(point);
    } else if (parts[0] === "f" && parts.length >= 4) {
      const face = parts.slice(1).map((token) => {
        const raw = Number(token?.split("/")[0]);
        if (!Number.isInteger(raw) || raw === 0) throw new Error("Invalid OBJ face");
        return raw < 0 ? sourceVertices.length + raw : raw - 1;
      });
      for (let index = 1; index < face.length - 1; index += 1) {
        const corners = [face[0], face[index], face[index + 1]];
        for (const corner of corners) {
          const point = sourceVertices[corner ?? -1];
          if (!point) throw new Error("OBJ face references a missing vertex");
          vertices.push(...point);
          triangles.push(triangles.length);
        }
      }
    }
  }
  return meshShape(vertices, triangles);
}
function parseBinaryStl(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getUint32(80, true);
  if (84 + count * 50 !== bytes.byteLength) throw new Error("Invalid binary STL");
  const vertices = [];
  const triangles = [];
  for (let triangle = 0; triangle < count; triangle += 1) {
    const base2 = 84 + triangle * 50 + 12;
    for (let corner = 0; corner < 3; corner += 1) {
      const offset = base2 + corner * 12;
      vertices.push(
        view.getFloat32(offset, true),
        view.getFloat32(offset + 4, true),
        view.getFloat32(offset + 8, true)
      );
      triangles.push(triangles.length);
    }
  }
  return meshShape(vertices, triangles);
}
function parseAsciiStl(text) {
  const vertices = [];
  const triangles = [];
  const matches = text.matchAll(
    /\bvertex\s+([-+\d.eE]+)\s+([-+\d.eE]+)\s+([-+\d.eE]+)/g
  );
  for (const match of matches) {
    vertices.push(Number(match[1]), Number(match[2]), Number(match[3]));
    triangles.push(triangles.length);
  }
  if (triangles.length % 3 !== 0) throw new Error("ASCII STL has incomplete facets");
  return meshShape(vertices, triangles);
}
function importModel(format, data, encoding) {
  const bytes = decode(data, encoding);
  if (format === "obj") return parseObj(new TextDecoder().decode(bytes));
  const binary = bytes.byteLength >= 84 && 84 + new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(80, true) * 50 === bytes.byteLength;
  return binary ? parseBinaryStl(bytes) : parseAsciiStl(new TextDecoder().decode(bytes));
}

// src/presets.ts
var value = (input, fallback, min = 0.1, max = 1e4) => Math.min(max, Math.max(min, input ?? fallback));
function generatePreset(template, parameters = {}) {
  switch (template) {
    case "pipe": {
      const height = value(parameters.height, 40);
      const radius = value(parameters.radius, 15);
      const thickness = Math.min(
        radius * 0.9,
        value(parameters.thickness, 2.5)
      );
      return {
        kind: "difference",
        children: [
          { kind: "cylinder", height, radius, segments: 64 },
          {
            kind: "cylinder",
            height: height + 2,
            radius: radius - thickness,
            segments: 64,
            transform: { translation: [0, 0, -1] }
          }
        ]
      };
    }
    case "gear": {
      const radius = value(parameters.radius, 22);
      const height = value(parameters.height, 6);
      const teeth = Math.round(value(parameters.teeth, 18, 6, 80));
      const holeRadius = Math.min(
        radius * 0.7,
        value(parameters.holeRadius, 5)
      );
      const points = [];
      for (let index = 0; index < teeth * 4; index += 1) {
        const angle = index / (teeth * 4) * Math.PI * 2;
        const toothPhase = index % 4;
        const distance = toothPhase === 1 || toothPhase === 2 ? radius * 1.14 : radius;
        points.push([Math.cos(angle) * distance, Math.sin(angle) * distance]);
      }
      return {
        kind: "difference",
        children: [
          { kind: "extrude", points, height },
          {
            kind: "cylinder",
            height: height + 2,
            radius: holeRadius,
            segments: 48,
            transform: { translation: [0, 0, -1] }
          }
        ]
      };
    }
    case "bracket": {
      const width = value(parameters.width, 50);
      const depth = value(parameters.depth, 30);
      const height = value(parameters.height, 45);
      const thickness = Math.min(
        Math.min(depth, height) * 0.4,
        value(parameters.thickness, 5)
      );
      const holeRadius = value(parameters.holeRadius, 3.5);
      const solid = {
        kind: "union",
        children: [
          { kind: "box", size: [width, depth, thickness] },
          { kind: "box", size: [width, thickness, height] }
        ]
      };
      const holeA = {
        kind: "cylinder",
        height: thickness + 2,
        radius: holeRadius,
        segments: 40,
        transform: {
          translation: [width * 0.25, depth * 0.55, -1]
        }
      };
      const holeB = {
        ...holeA,
        transform: { translation: [width * 0.75, depth * 0.55, -1] }
      };
      return { kind: "difference", children: [solid, holeA, holeB] };
    }
    case "enclosure": {
      const width = value(parameters.width, 70);
      const depth = value(parameters.depth, 48);
      const height = value(parameters.height, 24);
      const thickness = Math.min(
        Math.min(width, depth, height) * 0.3,
        value(parameters.thickness, 2.5)
      );
      return {
        kind: "difference",
        children: [
          { kind: "box", size: [width, depth, height] },
          {
            kind: "box",
            size: [width - thickness * 2, depth - thickness * 2, height],
            transform: { translation: [thickness, thickness, thickness] }
          }
        ]
      };
    }
    case "bolt": {
      const radius = value(parameters.radius, 6);
      const height = value(parameters.height, 32);
      const headHeight = value(parameters.thickness, 5);
      return {
        kind: "union",
        children: [
          { kind: "cylinder", height, radius: radius * 0.55, segments: 48 },
          {
            kind: "cylinder",
            height: headHeight,
            radius,
            segments: 6,
            transform: { translation: [0, 0, height] }
          }
        ]
      };
    }
  }
}

// src/schema.ts
import { z } from "zod";
var finiteNumber = z.number().finite();
var positive = finiteNumber.positive().max(1e5);
var vec2 = z.tuple([finiteNumber, finiteNumber]);
var vec3 = z.tuple([finiteNumber, finiteNumber, finiteNumber]);
var transform = z.object({
  translation: vec3.optional(),
  rotation: vec3.optional(),
  scale: z.tuple([
    finiteNumber.refine((value2) => value2 !== 0, "Scale cannot be zero"),
    finiteNumber.refine((value2) => value2 !== 0, "Scale cannot be zero"),
    finiteNumber.refine((value2) => value2 !== 0, "Scale cannot be zero")
  ]).optional()
}).strict();
var base = { transform: transform.optional() };
var shapeSchema = z.lazy(
  () => z.discriminatedUnion("kind", [
    z.object({
      ...base,
      kind: z.literal("box"),
      size: z.tuple([positive, positive, positive]),
      center: z.boolean().optional()
    }),
    z.object({
      ...base,
      kind: z.literal("sphere"),
      radius: positive,
      segments: z.number().int().min(8).max(256).optional()
    }),
    z.object({
      ...base,
      kind: z.literal("cylinder"),
      height: positive,
      radius: positive,
      segments: z.number().int().min(3).max(256).optional(),
      center: z.boolean().optional()
    }),
    z.object({
      ...base,
      kind: z.literal("cone"),
      height: positive,
      radiusBottom: positive,
      radiusTop: finiteNumber.min(0).max(1e5),
      segments: z.number().int().min(3).max(256).optional(),
      center: z.boolean().optional()
    }),
    z.object({
      ...base,
      kind: z.literal("extrude"),
      points: z.array(vec2).min(3).max(2048),
      height: positive,
      twist: finiteNumber.min(-1e4).max(1e4).optional(),
      scaleTop: vec2.optional(),
      center: z.boolean().optional()
    }),
    z.object({
      ...base,
      kind: z.literal("mesh"),
      vertices: z.array(finiteNumber).min(9).max(9e5),
      triangles: z.array(z.number().int().nonnegative()).min(3).max(9e5)
    }),
    z.object({
      ...base,
      kind: z.enum(["union", "difference", "intersection"]),
      children: z.array(shapeSchema).min(2).max(64)
    })
  ])
);
var colorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/, "Use a six-digit hex color such as #4f8cff");
var modelNameSchema = z.string().trim().min(1).max(120);

// src/server.ts
var STUDIO_RESOURCE_URI = "ui://cad-studio/studio.html";
async function loadWidgetHtml() {
  const adjacent = new URL("./widget.html", import.meta.url);
  try {
    return await readFile(adjacent, "utf8");
  } catch {
    return readFile(join(process.cwd(), "dist", "widget.html"), "utf8");
  }
}
function content(text) {
  return [{ type: "text", text }];
}
function summary(model) {
  return {
    id: model.id,
    name: model.name,
    color: model.color,
    revision: model.revision,
    updatedAt: model.updatedAt,
    kind: model.shape.kind
  };
}
async function modelPayload(model, store, mesh) {
  const rendered = mesh ?? await renderShape(model.shape);
  return {
    models: store.list(),
    activeModel: model,
    mesh: rendered
  };
}
function addVec(left, right, fallback) {
  return [
    (left?.[0] ?? fallback) + (right?.[0] ?? fallback),
    (left?.[1] ?? fallback) + (right?.[1] ?? fallback),
    (left?.[2] ?? fallback) + (right?.[2] ?? fallback)
  ];
}
function multiplyVec(left, right) {
  return [
    (left?.[0] ?? 1) * (right?.[0] ?? 1),
    (left?.[1] ?? 1) * (right?.[1] ?? 1),
    (left?.[2] ?? 1) * (right?.[2] ?? 1)
  ];
}
function applyTransform2(shape, next) {
  const current = shape.transform;
  return {
    ...shape,
    transform: {
      translation: addVec(current?.translation, next.translation, 0),
      rotation: addVec(current?.rotation, next.rotation, 0),
      scale: multiplyVec(current?.scale, next.scale)
    }
  };
}
async function createCadStudioServer(options) {
  await options.store.ready();
  const widgetHtml = options.widgetHtml ?? await loadWidgetHtml();
  const { store } = options;
  const server = new McpServer(
    { name: "mcp-cad-studio", version: "0.1.0" },
    {
      instructions: "Use CAD tools to create, inspect, edit, combine, import, and export parametric 3D models. Call studio_ui when the user wants the interactive CAD canvas. Every data tool works without the UI."
    }
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
          csp: { resourceDomains: [], connectDomains: [] }
        }
      }
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
              csp: { resourceDomains: [], connectDomains: [] }
            }
          }
        }
      ]
    })
  );
  registerAppTool(
    server,
    "studio_ui",
    {
      title: "Open CAD Studio",
      description: "Open the interactive CAD Studio. Use this when the user asks to view or work with a model visually.",
      inputSchema: {
        modelId: z2.string().uuid().optional().describe("Model to select initially")
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false
      },
      _meta: {
        ui: { resourceUri: STUDIO_RESOURCE_URI },
        "openai/outputTemplate": STUDIO_RESOURCE_URI,
        "openai/toolInvocation/invoking": "Opening CAD Studio\u2026",
        "openai/toolInvocation/invoked": "CAD Studio ready"
      }
    },
    async ({ modelId }) => {
      let selected = modelId ? store.get(modelId) : void 0;
      if (!selected) {
        const first = store.list()[0];
        selected = first ? store.get(first.id) : await store.create({
          name: "Starter block",
          color: "#6ee7b7",
          shape: { kind: "box", size: [40, 30, 18], center: true }
        });
      }
      const snapshot = await modelPayload(selected, store);
      return {
        structuredContent: snapshot,
        content: content(`Opened CAD Studio with ${selected.name}.`)
      };
    }
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
        openWorldHint: false
      }
    },
    async () => {
      const models = store.list();
      return {
        structuredContent: { models },
        content: content(
          models.length === 0 ? "The CAD studio is empty." : `Found ${models.length} CAD model${models.length === 1 ? "" : "s"}.`
        )
      };
    }
  );
  server.registerTool(
    "load_model",
    {
      title: "Load CAD model",
      description: "Load a saved CAD model, its editable parametric definition, and render mesh.",
      inputSchema: { modelId: z2.string().uuid() },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false
      }
    },
    async ({ modelId }) => {
      const model = store.get(modelId);
      return {
        structuredContent: await modelPayload(model, store),
        content: content(
          `Loaded ${model.name} (revision ${model.revision}, ${model.shape.kind}).`
        )
      };
    }
  );
  server.registerTool(
    "create_model",
    {
      title: "Create CAD model",
      description: "Create a CAD model from a declarative parametric shape tree. Supports primitives, extrusions, transforms, mesh input, and boolean operations.",
      inputSchema: {
        name: modelNameSchema,
        color: colorSchema.default("#6ee7b7"),
        shape: shapeSchema
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false
      }
    },
    async ({ name, color, shape }) => {
      const mesh = await renderShape(shape);
      const model = await store.create({ name, color, shape });
      return {
        structuredContent: await modelPayload(model, store, mesh),
        content: content(
          `Created ${model.name} with ${mesh.triangleCount} triangles (model ${model.id}).`
        )
      };
    }
  );
  server.registerTool(
    "generate_model",
    {
      title: "Generate CAD model",
      description: "Generate a useful parametric CAD model from a built-in template: bracket, pipe, gear, enclosure, or bolt.",
      inputSchema: {
        name: modelNameSchema,
        template: z2.enum(["bracket", "pipe", "gear", "enclosure", "bolt"]),
        color: colorSchema.default("#60a5fa"),
        parameters: z2.object({
          width: z2.number().positive().optional(),
          depth: z2.number().positive().optional(),
          height: z2.number().positive().optional(),
          thickness: z2.number().positive().optional(),
          radius: z2.number().positive().optional(),
          holeRadius: z2.number().positive().optional(),
          teeth: z2.number().int().min(6).max(80).optional()
        }).optional()
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false
      }
    },
    async ({ name, template, color, parameters }) => {
      const shape = generatePreset(template, parameters);
      const mesh = await renderShape(shape);
      const model = await store.create({ name, color, shape });
      return {
        structuredContent: await modelPayload(model, store, mesh),
        content: content(
          `Generated ${template} model ${model.name} with volume ${mesh.volume.toFixed(2)} mm\xB3.`
        )
      };
    }
  );
  server.registerTool(
    "update_model",
    {
      title: "Update CAD model",
      description: "Edit a CAD model by replacing its name, color, or parametric shape definition. Pass expectedRevision to prevent overwriting concurrent edits.",
      inputSchema: {
        modelId: z2.string().uuid(),
        name: modelNameSchema.optional(),
        color: colorSchema.optional(),
        shape: shapeSchema.optional(),
        expectedRevision: z2.number().int().positive().optional()
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false
      }
    },
    async ({ modelId, name, color, shape, expectedRevision }) => {
      const current = store.get(modelId);
      const nextShape = shape ?? current.shape;
      const mesh = await renderShape(nextShape);
      const model = await store.update(modelId, {
        name,
        color,
        shape,
        expectedRevision
      });
      return {
        structuredContent: await modelPayload(model, store, mesh),
        content: content(`Updated ${model.name} to revision ${model.revision}.`)
      };
    }
  );
  server.registerTool(
    "transform_model",
    {
      title: "Transform CAD model",
      description: "Apply an incremental translation, Euler rotation in degrees, or scale to a CAD model.",
      inputSchema: {
        modelId: z2.string().uuid(),
        translation: z2.tuple([z2.number(), z2.number(), z2.number()]).optional(),
        rotation: z2.tuple([z2.number(), z2.number(), z2.number()]).optional(),
        scale: z2.tuple([
          z2.number().refine((entry) => entry !== 0),
          z2.number().refine((entry) => entry !== 0),
          z2.number().refine((entry) => entry !== 0)
        ]).optional(),
        expectedRevision: z2.number().int().positive().optional()
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false
      }
    },
    async ({ modelId, translation, rotation, scale, expectedRevision }) => {
      const current = store.get(modelId);
      const shape = applyTransform2(current.shape, { translation, rotation, scale });
      const mesh = await renderShape(shape);
      const model = await store.update(modelId, { shape, expectedRevision });
      return {
        structuredContent: await modelPayload(model, store, mesh),
        content: content(`Transformed ${model.name}.`)
      };
    }
  );
  server.registerTool(
    "boolean_models",
    {
      title: "Combine CAD models",
      description: "Create a new model by union, difference, or intersection of two or more saved models.",
      inputSchema: {
        name: modelNameSchema,
        operation: z2.enum(["union", "difference", "intersection"]),
        modelIds: z2.array(z2.string().uuid()).min(2).max(32),
        color: colorSchema.optional()
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false
      }
    },
    async ({ name, operation, modelIds, color }) => {
      const sources = modelIds.map((id) => store.get(id));
      const shape = {
        kind: operation,
        children: sources.map((model2) => model2.shape)
      };
      const mesh = await renderShape(shape);
      const model = await store.create({
        name,
        color: color ?? sources[0]?.color ?? "#a78bfa",
        shape
      });
      return {
        structuredContent: await modelPayload(model, store, mesh),
        content: content(
          `Created ${operation} model ${model.name} from ${sources.length} models.`
        )
      };
    }
  );
  server.registerTool(
    "duplicate_model",
    {
      title: "Duplicate CAD model",
      description: "Create an editable copy of a saved CAD model.",
      inputSchema: {
        modelId: z2.string().uuid(),
        name: modelNameSchema.optional()
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false
      }
    },
    async ({ modelId, name }) => {
      const model = await store.duplicate(modelId, name);
      return {
        structuredContent: await modelPayload(model, store),
        content: content(`Duplicated model as ${model.name} (${model.id}).`)
      };
    }
  );
  server.registerTool(
    "delete_model",
    {
      title: "Delete CAD model",
      description: "Permanently delete a saved CAD model from this studio.",
      inputSchema: { modelId: z2.string().uuid() },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: false
      }
    },
    async ({ modelId }) => {
      const deleted = await store.delete(modelId);
      return {
        structuredContent: {
          models: store.list(),
          deletedModel: summary(deleted),
          activeModel: null,
          mesh: null
        },
        content: content(`Deleted ${deleted.name}.`)
      };
    }
  );
  server.registerTool(
    "import_model",
    {
      title: "Import CAD model",
      description: "Import an STL or OBJ model from text or base64 data and save it in the studio.",
      inputSchema: {
        name: modelNameSchema,
        format: z2.enum(["stl", "obj"]),
        data: z2.string().min(1),
        encoding: z2.enum(["text", "base64"]).default("text"),
        color: colorSchema.default("#f59e0b")
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false
      }
    },
    async ({ name, format, data, encoding, color }) => {
      const shape = importModel(format, data, encoding);
      const mesh = await renderShape(shape);
      const model = await store.create({ name, color, shape });
      return {
        structuredContent: await modelPayload(model, store, mesh),
        content: content(
          `Imported ${model.name} from ${format.toUpperCase()} (${mesh.triangleCount} triangles).`
        )
      };
    }
  );
  server.registerTool(
    "export_model",
    {
      title: "Export CAD model",
      description: "Export a saved CAD model as ASCII STL or OBJ data.",
      inputSchema: {
        modelId: z2.string().uuid(),
        format: z2.enum(["stl", "obj"])
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false
      }
    },
    async ({ modelId, format }) => {
      const model = store.get(modelId);
      const data = format === "stl" ? await exportStl(model.shape, model.name) : await exportObj(model.shape, model.name);
      const filename = `${model.name.replace(/[^a-zA-Z0-9_-]+/g, "-").toLowerCase()}.${format}`;
      return {
        structuredContent: { format, filename, data, model: summary(model) },
        content: content(
          `Exported ${model.name} as ${filename} (${Buffer.byteLength(data)} bytes).`
        )
      };
    }
  );
  return server;
}

// src/http.ts
import { createServer as createHttpServer } from "http";
import { createServer as createHttpsServer } from "https";
import { readFile as readFile2 } from "fs/promises";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { generate } from "selfsigned";
async function tlsOptions(options) {
  if (!options.https) return null;
  if (options.tlsCert && !options.tlsKey || !options.tlsCert && options.tlsKey) {
    throw new Error("--tls-cert and --tls-key must be provided together");
  }
  if (options.tlsCert && options.tlsKey) {
    return {
      key: await readFile2(options.tlsKey, "utf8"),
      cert: await readFile2(options.tlsCert, "utf8"),
      selfSigned: false
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
            { type: 7, ip: "::1" }
          ]
        }
      ]
    }
  );
  return { key: certificate.private, cert: certificate.cert, selfSigned: true };
}
async function startNetworkServer(options) {
  await options.store.ready();
  const tls = await tlsOptions(options);
  const requestHandler = async (request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Cache-Control", "no-store");
    if (url.pathname === "/health" && request.method === "GET") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({
          status: "ok",
          name: "mcp-cad-studio",
          transport: options.https ? "https" : "http"
        })
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
        "Access-Control-Allow-Methods": "POST, OPTIONS"
      });
      response.end();
      return;
    }
    if (request.method !== "POST") {
      response.writeHead(405, {
        Allow: "POST, OPTIONS",
        "Content-Type": "application/json"
      });
      response.end(
        JSON.stringify({
          jsonrpc: "2.0",
          error: { code: -32e3, message: "Method not allowed" },
          id: null
        })
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
      widgetHtml: options.widgetHtml
    });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: void 0,
      enableJsonResponse: true
    });
    try {
      await mcp.connect(transport);
      await transport.handleRequest(request, response);
    } catch (error) {
      process.stderr.write(
        `[cad-studio] HTTP request failed: ${error instanceof Error ? error.message : String(error)}
`
      );
      if (!response.headersSent) {
        response.writeHead(500, { "Content-Type": "application/json" });
        response.end(
          JSON.stringify({
            jsonrpc: "2.0",
            error: { code: -32603, message: "Internal server error" },
            id: null
          })
        );
      }
    } finally {
      await transport.close();
      await mcp.close();
    }
  };
  const server = tls ? createHttpsServer({ key: tls.key, cert: tls.cert }, requestHandler) : createHttpServer(requestHandler);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : options.port;
  const displayHost = options.host === "0.0.0.0" || options.host === "::" ? "localhost" : options.host;
  return {
    server,
    url: `${options.https ? "https" : "http"}://${displayHost}:${port}/mcp`,
    selfSigned: tls?.selfSigned ?? false
  };
}

// src/store.ts
import { randomUUID } from "crypto";
import { mkdir, readFile as readFile3, rename, writeFile } from "fs/promises";
import { dirname } from "path";
var CadStore = class {
  dataFile;
  models = /* @__PURE__ */ new Map();
  loaded = false;
  writeChain = Promise.resolve();
  constructor(dataFile) {
    this.dataFile = dataFile;
  }
  async ready() {
    if (this.loaded) return;
    this.loaded = true;
    if (!this.dataFile) return;
    try {
      const document = JSON.parse(await readFile3(this.dataFile, "utf8"));
      if (document.version !== 1 || !Array.isArray(document.models)) {
        throw new Error("Unsupported CAD Studio data format");
      }
      for (const model of document.models) this.models.set(model.id, model);
    } catch (error) {
      const code = error.code;
      if (code !== "ENOENT") throw error;
    }
  }
  list() {
    return [...this.models.values()].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)).map((model) => ({
      id: model.id,
      name: model.name,
      color: model.color,
      revision: model.revision,
      updatedAt: model.updatedAt,
      kind: model.shape.kind
    }));
  }
  get(id) {
    const model = this.models.get(id);
    if (!model) throw new Error(`CAD model not found: ${id}`);
    return structuredClone(model);
  }
  async create(input) {
    const timestamp = (/* @__PURE__ */ new Date()).toISOString();
    const model = {
      id: randomUUID(),
      name: input.name,
      color: input.color,
      shape: structuredClone(input.shape),
      revision: 1,
      createdAt: timestamp,
      updatedAt: timestamp
    };
    this.models.set(model.id, model);
    await this.persist();
    return structuredClone(model);
  }
  async update(id, input) {
    const current = this.models.get(id);
    if (!current) throw new Error(`CAD model not found: ${id}`);
    if (input.expectedRevision !== void 0 && input.expectedRevision !== current.revision) {
      throw new Error(
        `Revision conflict: expected ${input.expectedRevision}, current revision is ${current.revision}`
      );
    }
    const model = {
      ...current,
      name: input.name ?? current.name,
      color: input.color ?? current.color,
      shape: input.shape ? structuredClone(input.shape) : current.shape,
      revision: current.revision + 1,
      updatedAt: (/* @__PURE__ */ new Date()).toISOString()
    };
    this.models.set(id, model);
    await this.persist();
    return structuredClone(model);
  }
  async duplicate(id, name) {
    const source = this.get(id);
    return this.create({
      name: name ?? `${source.name} copy`,
      color: source.color,
      shape: source.shape
    });
  }
  async delete(id) {
    const model = this.get(id);
    this.models.delete(id);
    await this.persist();
    return model;
  }
  async persist() {
    if (!this.dataFile) return;
    const payload = `${JSON.stringify(
      { version: 1, models: [...this.models.values()] },
      null,
      2
    )}
`;
    const dataFile = this.dataFile;
    this.writeChain = this.writeChain.then(async () => {
      await mkdir(dirname(dataFile), { recursive: true });
      const temporary = `${dataFile}.${process.pid}.tmp`;
      await writeFile(temporary, payload, "utf8");
      await rename(temporary, dataFile);
    });
    await this.writeChain;
  }
};
export {
  CadStore,
  STUDIO_RESOURCE_URI,
  createCadStudioServer,
  exportObj,
  exportStl,
  generatePreset,
  importModel,
  renderShape,
  startNetworkServer
};
//# sourceMappingURL=index.js.map