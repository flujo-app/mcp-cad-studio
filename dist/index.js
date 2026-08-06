#!/usr/bin/env node

// src/server.ts
import { realpathSync } from "fs";
import { readFile } from "fs/promises";
import { dirname, join } from "path";
import { fileURLToPath, pathToFileURL } from "url";
import {
  registerAppResource,
  registerAppTool,
  RESOURCE_MIME_TYPE
} from "@modelcontextprotocol/ext-apps/server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z as z2 } from "zod";

// src/geometry.ts
import createManifoldModule from "manifold-3d";

// src/schema.ts
import { z } from "zod";
var finiteNumber = z.number().finite();
var positive = finiteNumber.positive().max(1e5);
var vec2 = z.tuple([finiteNumber, finiteNumber]);
var vec3 = z.tuple([finiteNumber, finiteNumber, finiteNumber]);
var transform = z.object({
  translation: vec3.describe("XYZ translation, in the studio's millimeter units").optional(),
  rotation: vec3.describe("XYZ Euler rotation in degrees").optional(),
  scale: z.tuple([
    finiteNumber.refine((value2) => value2 !== 0, "Scale cannot be zero"),
    finiteNumber.refine((value2) => value2 !== 0, "Scale cannot be zero"),
    finiteNumber.refine((value2) => value2 !== 0, "Scale cannot be zero")
  ]).describe("Non-zero XYZ scale factors").optional()
}).strict().describe("Optional transform applied after constructing this node");
var base = { transform: transform.optional() };
var shapeSchema = z.lazy(
  () => z.discriminatedUnion("kind", [
    z.object({
      ...base,
      kind: z.literal("box"),
      size: z.tuple([positive, positive, positive]).describe("Positive XYZ dimensions"),
      center: z.boolean().describe("Center the box on the origin instead of using its minimum corner").optional()
    }).strict().describe("Rectangular solid"),
    z.object({
      ...base,
      kind: z.literal("sphere"),
      radius: positive.describe("Positive radius"),
      segments: z.number().int().min(8).max(256).describe("Surface resolution; normally 32\u201364").optional()
    }).strict().describe("Spherical solid centered on the origin"),
    z.object({
      ...base,
      kind: z.literal("cylinder"),
      height: positive.describe("Positive Z-axis height"),
      radius: positive.describe("Positive radius"),
      segments: z.number().int().min(3).max(256).describe("Radial resolution; normally 32\u201364").optional(),
      center: z.boolean().describe("Center the height on Z=0 instead of starting at Z=0").optional()
    }).strict().describe("Cylindrical solid aligned to the Z axis"),
    z.object({
      ...base,
      kind: z.literal("cone"),
      height: positive.describe("Positive Z-axis height"),
      radiusBottom: positive.describe("Positive bottom radius"),
      radiusTop: finiteNumber.min(0).max(1e5).describe("Top radius; use 0 for a pointed cone"),
      segments: z.number().int().min(3).max(256).describe("Radial resolution; normally 32\u201364").optional(),
      center: z.boolean().describe("Center the height on Z=0 instead of starting at Z=0").optional()
    }).strict().describe("Cone or conical frustum aligned to the Z axis"),
    z.object({
      ...base,
      kind: z.literal("extrude"),
      points: z.array(vec2).min(3).max(2048).describe(
        "Ordered XY boundary of one simple polygon. Do not repeat the first point at the end; the boundary closes automatically."
      ),
      height: positive.describe("Positive extrusion height along Z"),
      twist: finiteNumber.min(-1e4).max(1e4).describe("Optional total twist in degrees").optional(),
      scaleTop: vec2.describe("Optional XY scale factors at the top of the extrusion").optional(),
      center: z.boolean().describe("Center the height on Z=0 instead of starting at Z=0").optional()
    }).strict().describe("Solid extrusion of a simple, non-self-intersecting XY polygon"),
    z.object({
      ...base,
      kind: z.literal("mesh"),
      vertices: z.array(finiteNumber).min(9).max(9e5).describe("Flat XYZ coordinate triples"),
      triangles: z.array(z.number().int().nonnegative()).min(3).max(9e5).describe(
        "Flat triples of zero-based vertex indices, wound counter-clockwise from outside. The mesh must be closed and manifold."
      )
    }).strict().describe("Closed, consistently wound, manifold triangle mesh"),
    z.object({
      ...base,
      kind: z.enum(["union", "difference", "intersection"]),
      children: z.array(shapeSchema).min(2).max(64).describe(
        "Operand shapes. For difference, the first child is the base and all later children are subtracted."
      )
    }).strict().describe("Boolean operation over two or more closed solids")
  ]).describe(
    "Complete declarative solid definition. Every object is strict; use only documented fields."
  )
);
var colorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/, "Use a six-digit hex color such as #4f8cff");
var modelNameSchema = z.string().trim().min(1).max(120);

// src/validation.ts
var MAX_SHAPE_DEPTH = 24;
var MAX_SHAPE_NODES = 256;
var MAX_EXTRUSION_VERTICES = 5e5;
function jsonPath(parts) {
  let result = "$";
  for (const part of parts) {
    if (typeof part === "number") {
      result += `[${part}]`;
    } else if (typeof part === "string" && /^[A-Za-z_$][\w$]*$/.test(part)) {
      result += `.${part}`;
    } else {
      result += `[${JSON.stringify(String(part))}]`;
    }
  }
  return result;
}
function childPath(path, property) {
  return typeof property === "number" ? `${path}[${property}]` : `${path}.${property}`;
}
function samePoint(left, right, tolerance) {
  return Math.abs(left[0] - right[0]) <= tolerance && Math.abs(left[1] - right[1]) <= tolerance;
}
function cross2(a, b, c) {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}
function pointOnSegment(point, start, end, tolerance) {
  return Math.abs(cross2(start, end, point)) <= tolerance && point[0] >= Math.min(start[0], end[0]) - tolerance && point[0] <= Math.max(start[0], end[0]) + tolerance && point[1] >= Math.min(start[1], end[1]) - tolerance && point[1] <= Math.max(start[1], end[1]) + tolerance;
}
function segmentsIntersect(a, b, c, d, tolerance) {
  const abC = cross2(a, b, c);
  const abD = cross2(a, b, d);
  const cdA = cross2(c, d, a);
  const cdB = cross2(c, d, b);
  if ((abC > tolerance && abD < -tolerance || abC < -tolerance && abD > tolerance) && (cdA > tolerance && cdB < -tolerance || cdA < -tolerance && cdB > tolerance)) {
    return true;
  }
  return Math.abs(abC) <= tolerance && pointOnSegment(c, a, b, tolerance) || Math.abs(abD) <= tolerance && pointOnSegment(d, a, b, tolerance) || Math.abs(cdA) <= tolerance && pointOnSegment(a, c, d, tolerance) || Math.abs(cdB) <= tolerance && pointOnSegment(b, c, d, tolerance);
}
function validatePolygon(points, path, issues) {
  const coordinateScale = Math.max(
    1,
    ...points.flatMap((point) => [Math.abs(point[0]), Math.abs(point[1])])
  );
  const pointTolerance = coordinateScale * 1e-10;
  const areaTolerance = coordinateScale * coordinateScale * 1e-12;
  if (samePoint(points[0], points.at(-1), pointTolerance)) {
    issues.push({
      severity: "error",
      code: "polygon_repeated_closing_point",
      path,
      message: "The first polygon point is repeated as the last point.",
      suggestion: "Remove the final point; extrusion polygons are closed automatically."
    });
  }
  for (let index = 0; index < points.length; index += 1) {
    const next = (index + 1) % points.length;
    if (samePoint(points[index], points[next], pointTolerance)) {
      issues.push({
        severity: "error",
        code: "polygon_zero_length_edge",
        path: childPath(path, next),
        message: `Polygon points ${index} and ${next} create a zero-length edge.`,
        suggestion: "Remove one of the duplicate adjacent points."
      });
      break;
    }
  }
  let twiceArea = 0;
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index];
    const next = points[(index + 1) % points.length];
    twiceArea += current[0] * next[1] - next[0] * current[1];
  }
  if (Math.abs(twiceArea) <= areaTolerance) {
    issues.push({
      severity: "error",
      code: "polygon_zero_area",
      path,
      message: "The extrusion polygon has zero or near-zero area.",
      suggestion: "Use at least three non-collinear boundary points."
    });
  }
  let foundIntersection = false;
  for (let left = 0; left < points.length && !foundIntersection; left += 1) {
    const leftNext = (left + 1) % points.length;
    for (let right = left + 1; right < points.length; right += 1) {
      const rightNext = (right + 1) % points.length;
      if (left === right || leftNext === right || rightNext === left) continue;
      if (segmentsIntersect(
        points[left],
        points[leftNext],
        points[right],
        points[rightNext],
        areaTolerance
      )) {
        issues.push({
          severity: "error",
          code: "polygon_self_intersection",
          path,
          message: `Polygon edges ${left}\u2013${leftNext} and ${right}\u2013${rightNext} intersect.`,
          suggestion: "Reorder or move the boundary points so the polygon does not cross itself."
        });
        foundIntersection = true;
        break;
      }
    }
  }
}
function meshPoint(vertices, index) {
  const offset = index * 3;
  return [vertices[offset], vertices[offset + 1], vertices[offset + 2]];
}
function triangleDoubleArea(a, b, c) {
  const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const ac = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  return Math.hypot(
    ab[1] * ac[2] - ab[2] * ac[1],
    ab[2] * ac[0] - ab[0] * ac[2],
    ab[0] * ac[1] - ab[1] * ac[0]
  );
}
function validateMesh(shape, path, issues) {
  if (shape.vertices.length % 3 !== 0) {
    issues.push({
      severity: "error",
      code: "mesh_incomplete_vertex",
      path: childPath(path, "vertices"),
      message: "The vertices array length must be divisible by 3 (x, y, z).",
      suggestion: "Add or remove values so every vertex has exactly three coordinates."
    });
  }
  if (shape.triangles.length % 3 !== 0) {
    issues.push({
      severity: "error",
      code: "mesh_incomplete_triangle",
      path: childPath(path, "triangles"),
      message: "The triangles array length must be divisible by 3.",
      suggestion: "Provide exactly three vertex indices per triangle."
    });
  }
  if (issues.some((issue) => issue.path.startsWith(path) && issue.severity === "error")) {
    return;
  }
  const vertexCount = shape.vertices.length / 3;
  const invalidIndex = shape.triangles.findIndex((index) => index >= vertexCount);
  if (invalidIndex !== -1) {
    issues.push({
      severity: "error",
      code: "mesh_index_out_of_bounds",
      path: childPath(childPath(path, "triangles"), invalidIndex),
      message: `Vertex index ${shape.triangles[invalidIndex]} is outside the 0\u2013${vertexCount - 1} range.`,
      suggestion: "Use only indices that refer to entries in the vertices array."
    });
    return;
  }
  const float32 = new Float32Array(shape.vertices);
  const weldedByPosition = /* @__PURE__ */ new Map();
  const weldedIndices = [];
  for (let vertex = 0; vertex < vertexCount; vertex += 1) {
    const offset = vertex * 3;
    const key = `${float32[offset]},${float32[offset + 1]},${float32[offset + 2]}`;
    let welded = weldedByPosition.get(key);
    if (welded === void 0) {
      welded = weldedByPosition.size;
      weldedByPosition.set(key, welded);
    }
    weldedIndices.push(welded);
  }
  const coordinates = Array.from(float32);
  const boundsMin = [Infinity, Infinity, Infinity];
  const boundsMax = [-Infinity, -Infinity, -Infinity];
  for (let vertex = 0; vertex < vertexCount; vertex += 1) {
    const point = meshPoint(coordinates, vertex);
    for (const axis of [0, 1, 2]) {
      boundsMin[axis] = Math.min(boundsMin[axis], point[axis]);
      boundsMax[axis] = Math.max(boundsMax[axis], point[axis]);
    }
  }
  const diagonal = Math.hypot(
    boundsMax[0] - boundsMin[0],
    boundsMax[1] - boundsMin[1],
    boundsMax[2] - boundsMin[2]
  );
  const areaTolerance = Math.max(1, diagonal * diagonal) * 1e-12;
  const faces = [];
  const edges = /* @__PURE__ */ new Map();
  let degenerateFaces = 0;
  for (let offset = 0; offset < shape.triangles.length; offset += 3) {
    const indices = shape.triangles.slice(offset, offset + 3);
    const welded = indices.map((index) => weldedIndices[index]);
    const faceIndex = faces.length;
    faces.push({ indices, welded });
    if (new Set(welded).size !== 3 || triangleDoubleArea(
      meshPoint(coordinates, indices[0]),
      meshPoint(coordinates, indices[1]),
      meshPoint(coordinates, indices[2])
    ) <= areaTolerance) {
      degenerateFaces += 1;
      continue;
    }
    for (let corner = 0; corner < 3; corner += 1) {
      const from = welded[corner];
      const to = welded[(corner + 1) % 3];
      const low = Math.min(from, to);
      const high = Math.max(from, to);
      const key = `${low}:${high}`;
      const edge = edges.get(key) ?? {
        faces: [],
        direction: 0,
        vertices: [low, high]
      };
      edge.faces.push(faceIndex);
      edge.direction += from === low ? 1 : -1;
      edges.set(key, edge);
    }
  }
  if (degenerateFaces > 0) {
    issues.push({
      severity: "error",
      code: "mesh_degenerate_triangles",
      path: childPath(path, "triangles"),
      message: `${degenerateFaces} triangle${degenerateFaces === 1 ? " is" : "s are"} collapsed or has zero area.`,
      suggestion: "Remove collapsed faces and ensure every triangle uses three non-collinear vertices."
    });
  }
  let boundaryEdges = 0;
  let overusedEdges = 0;
  let misorientedEdges = 0;
  for (const edge of edges.values()) {
    if (edge.faces.length === 1) boundaryEdges += 1;
    else if (edge.faces.length !== 2) overusedEdges += 1;
    else if (edge.direction !== 0) misorientedEdges += 1;
  }
  if (boundaryEdges > 0) {
    issues.push({
      severity: "error",
      code: "mesh_open_boundary",
      path: childPath(path, "triangles"),
      message: `${boundaryEdges} mesh edge${boundaryEdges === 1 ? " has" : "s have"} only one adjacent triangle, so the mesh is open.`,
      suggestion: "Cap every hole; a solid mesh requires exactly two triangles around every edge."
    });
  }
  if (overusedEdges > 0) {
    issues.push({
      severity: "error",
      code: "mesh_non_manifold_edges",
      path: childPath(path, "triangles"),
      message: `${overusedEdges} mesh edge${overusedEdges === 1 ? " is" : "s are"} shared by more than two triangles.`,
      suggestion: "Split or remove overlapping faces so exactly two triangles share each edge."
    });
  }
  if (misorientedEdges > 0) {
    issues.push({
      severity: "error",
      code: "mesh_inconsistent_winding",
      path: childPath(path, "triangles"),
      message: `${misorientedEdges} shared edge${misorientedEdges === 1 ? " has" : "s have"} triangles wound in the same direction.`,
      suggestion: "Reverse the index order of inconsistent triangles so all faces point outward."
    });
  }
  if (boundaryEdges === 0 && overusedEdges === 0 && degenerateFaces === 0 && faces.length > 0) {
    const facesByVertex = /* @__PURE__ */ new Map();
    for (let faceIndex = 0; faceIndex < faces.length; faceIndex += 1) {
      for (const vertex of faces[faceIndex].welded) {
        const entries = facesByVertex.get(vertex) ?? /* @__PURE__ */ new Set();
        entries.add(faceIndex);
        facesByVertex.set(vertex, entries);
      }
    }
    const adjacencyByVertex = /* @__PURE__ */ new Map();
    for (const edge of edges.values()) {
      if (edge.faces.length !== 2) continue;
      const [left, right] = edge.faces;
      for (const vertex of edge.vertices) {
        const adjacency = adjacencyByVertex.get(vertex) ?? /* @__PURE__ */ new Map();
        const leftNeighbors = adjacency.get(left) ?? /* @__PURE__ */ new Set();
        const rightNeighbors = adjacency.get(right) ?? /* @__PURE__ */ new Set();
        leftNeighbors.add(right);
        rightNeighbors.add(left);
        adjacency.set(left, leftNeighbors);
        adjacency.set(right, rightNeighbors);
        adjacencyByVertex.set(vertex, adjacency);
      }
    }
    let disconnectedFans = 0;
    for (const [vertex, incident] of facesByVertex) {
      if (incident.size < 2) continue;
      const adjacency = adjacencyByVertex.get(vertex) ?? /* @__PURE__ */ new Map();
      const first = incident.values().next().value;
      if (first === void 0) continue;
      const reached = /* @__PURE__ */ new Set([first]);
      const queue = [first];
      while (queue.length > 0) {
        const face = queue.pop();
        for (const neighbor of adjacency.get(face) ?? []) {
          if (reached.has(neighbor)) continue;
          reached.add(neighbor);
          queue.push(neighbor);
        }
      }
      if (reached.size !== incident.size) disconnectedFans += 1;
    }
    if (disconnectedFans > 0) {
      issues.push({
        severity: "error",
        code: "mesh_non_manifold_vertices",
        path: childPath(path, "vertices"),
        message: `${disconnectedFans} welded ${disconnectedFans === 1 ? "vertex joins" : "vertices join"} disconnected surface fans.`,
        suggestion: "Do not join otherwise separate closed shells at only a point."
      });
    }
  }
}
function semanticIssues(shape) {
  const issues = [];
  let nodeCount = 0;
  const visit = (node, path, depth) => {
    nodeCount += 1;
    if (depth > MAX_SHAPE_DEPTH) {
      issues.push({
        severity: "error",
        code: "shape_too_deep",
        path,
        message: `The shape tree exceeds the maximum depth of ${MAX_SHAPE_DEPTH}.`,
        suggestion: "Flatten nested boolean groups where possible."
      });
      return;
    }
    if (nodeCount > MAX_SHAPE_NODES) {
      if (!issues.some((issue) => issue.code === "shape_too_many_nodes")) {
        issues.push({
          severity: "error",
          code: "shape_too_many_nodes",
          path,
          message: `The shape tree exceeds the maximum of ${MAX_SHAPE_NODES} nodes.`,
          suggestion: "Simplify repeated detail or split it across separate models."
        });
      }
      return;
    }
    if (node.kind === "extrude") {
      validatePolygon(node.points, childPath(path, "points"), issues);
      const divisions = Math.max(0, Math.ceil(Math.abs(node.twist ?? 0) / 15) - 1);
      const estimatedVertices = node.points.length * (divisions + 2);
      if (estimatedVertices > MAX_EXTRUSION_VERTICES) {
        issues.push({
          severity: "error",
          code: "extrusion_too_complex",
          path,
          message: `This twisted extrusion would create roughly ${estimatedVertices.toLocaleString()} profile vertices.`,
          suggestion: "Reduce the point count or twist angle, or build the detail with simpler solids."
        });
      }
      if (node.scaleTop?.some((entry) => entry < 0)) {
        issues.push({
          severity: "warning",
          code: "extrusion_negative_top_scale",
          path: childPath(path, "scaleTop"),
          message: "A negative top scale can invert the profile through itself.",
          suggestion: "Prefer non-negative top scale values unless the inversion is intentional."
        });
      }
    } else if (node.kind === "mesh") {
      validateMesh(node, path, issues);
    } else if (node.kind === "union" || node.kind === "difference" || node.kind === "intersection") {
      node.children.forEach(
        (child, index) => visit(child, childPath(childPath(path, "children"), index), depth + 1)
      );
    }
  };
  visit(shape, "$", 0);
  return issues;
}
function validateShape(input) {
  const parsed = shapeSchema.safeParse(input);
  const issues = [];
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      issues.push({
        severity: "error",
        code: `schema_${issue.code}`,
        path: jsonPath(issue.path),
        message: issue.message
      });
    }
  } else {
    issues.push(...semanticIssues(parsed.data));
  }
  const errors = issues.filter((issue) => issue.severity === "error");
  return {
    valid: errors.length === 0,
    errors,
    warnings: issues.filter((issue) => issue.severity === "warning")
  };
}
var ShapeValidationError = class extends Error {
  issues;
  constructor(issues) {
    const details = issues.slice(0, 8).map(
      (issue) => `- ${issue.path}: ${issue.message}${issue.suggestion ? ` ${issue.suggestion}` : ""}`
    ).join("\n");
    const remaining = Math.max(0, issues.length - 8);
    super(
      `Shape validation failed with ${issues.length} error${issues.length === 1 ? "" : "s"}:
${details}${remaining ? `
- \u2026and ${remaining} more.` : ""}`
    );
    this.name = "ShapeValidationError";
    this.issues = issues;
  }
};
function assertValidShape(input) {
  const result = validateShape(input);
  if (!result.valid) throw new ShapeValidationError(result.errors);
  return input;
}

// src/geometry.ts
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
var kernelStatusHelp = {
  NonFiniteVertex: "One or more calculated vertices are NaN or infinite. Check dimensions, transforms, and mesh coordinates.",
  NotManifold: "The result is not a closed 2-manifold solid. Mesh edges must have exactly two oppositely wound faces; extrusion outlines must not repeat or cross; boolean operands should have clean closed volumes.",
  VertexOutOfBounds: "A triangle references a vertex outside the mesh vertex array.",
  PropertiesWrongLength: "The mesh vertex-property array does not contain complete XYZ triples.",
  MissingPositionProperties: "The mesh is missing XYZ position properties.",
  MergeVectorsDifferentLengths: "The mesh repair metadata is inconsistent.",
  MergeIndexOutOfBounds: "The mesh repair metadata references a missing vertex.",
  TransformWrongLength: "A transform does not contain the required number of values.",
  RunIndexWrongLength: "The imported mesh contains invalid run metadata.",
  FaceIDWrongLength: "The imported mesh contains invalid face metadata.",
  InvalidConstruction: "The requested solid is geometrically invalid. Check for collapsed dimensions, coincident surfaces, and self-intersections.",
  ResultTooLarge: "The result exceeds the CAD kernel's size limit. Reduce segments, polygon points, twist, or boolean complexity.",
  InvalidTangents: "The imported mesh contains invalid tangent data.",
  Cancelled: "The CAD kernel operation was cancelled."
};
function kernelStatusError(status) {
  const help = kernelStatusHelp[status] ?? "Simplify the shape and validate each child solid independently.";
  return new Error(
    `CAD kernel rejected the shape (${status}). ${help} Use validate_shape before saving to get structured preflight diagnostics.`
  );
}
function friendlyKernelError(error) {
  if (error instanceof Error && error.message.startsWith("CAD kernel rejected")) {
    return error;
  }
  const message = error instanceof Error ? error.message : String(error);
  if (/not[ _-]?manifold/i.test(message)) {
    return kernelStatusError("NotManifold");
  }
  return new Error(
    `CAD kernel could not build the shape: ${message}. Use validate_shape before saving to get structured preflight diagnostics.`,
    { cause: error }
  );
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
  const validated = assertValidShape(shape);
  const module = await getManifoldModule();
  let solid;
  try {
    solid = await buildNode(validated, module);
  } catch (error) {
    throw friendlyKernelError(error);
  }
  const status = solid.status();
  if (status !== "NoError") {
    solid.delete();
    throw kernelStatusError(String(status));
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

// src/model-patches.ts
var blockedTokens = /* @__PURE__ */ new Set(["__proto__", "prototype", "constructor"]);
function decodePointer(path) {
  if (!path.startsWith("/") || path === "/") {
    throw new Error(
      "Patch path must point inside the editable model, such as /shape/size/0."
    );
  }
  return path.slice(1).split("/").map((token) => {
    if (/~(?:[^01]|$)/.test(token)) {
      throw new Error(`Patch path contains an invalid JSON Pointer escape: ${path}`);
    }
    const decoded = token.replaceAll("~1", "/").replaceAll("~0", "~");
    if (blockedTokens.has(decoded)) {
      throw new Error(`Patch path contains a forbidden property: ${decoded}`);
    }
    return decoded;
  });
}
function arrayIndex(token, length, allowEnd) {
  if (!/^(0|[1-9]\d*)$/.test(token)) {
    throw new Error(`Expected an array index but received ${JSON.stringify(token)}.`);
  }
  const index = Number(token);
  if (index > length || !allowEnd && index === length) {
    throw new Error(`Array index ${index} is outside the current array.`);
  }
  return index;
}
function isContainer(value2) {
  return value2 !== null && typeof value2 === "object";
}
function parentAt(document, tokens) {
  let current = document;
  for (const token of tokens.slice(0, -1)) {
    if (!isContainer(current)) {
      throw new Error(`Patch path enters a non-container value at ${JSON.stringify(token)}.`);
    }
    if (Array.isArray(current)) {
      const index = arrayIndex(token, current.length, false);
      current = current[index];
    } else {
      if (!Object.hasOwn(current, token)) {
        throw new Error(`Patch path property does not exist: ${token}`);
      }
      current = current[token];
    }
  }
  if (!isContainer(current)) {
    throw new Error("Patch path parent is not an object or array.");
  }
  return { parent: current, token: tokens.at(-1) };
}
function applyPatch(document, patch) {
  const tokens = decodePointer(patch.path);
  if (!(/* @__PURE__ */ new Set(["name", "color", "shape"])).has(tokens[0])) {
    throw new Error("Only /name, /color, and /shape may be patched.");
  }
  const { parent, token } = parentAt(document, tokens);
  if (Array.isArray(parent)) {
    if (patch.op === "add") {
      if (token === "-") {
        parent.push(structuredClone(patch.value));
      } else {
        parent.splice(arrayIndex(token, parent.length, true), 0, structuredClone(patch.value));
      }
    } else {
      const index = arrayIndex(token, parent.length, false);
      if (patch.op === "remove") parent.splice(index, 1);
      else parent[index] = structuredClone(patch.value);
    }
    return;
  }
  if (patch.op !== "add" && !Object.hasOwn(parent, token)) {
    throw new Error(`Patch path property does not exist: ${token}`);
  }
  if (patch.op === "remove") delete parent[token];
  else parent[token] = structuredClone(patch.value);
}
function applyModelPatches(model, patches) {
  const document = structuredClone({
    name: model.name,
    color: model.color,
    shape: model.shape
  });
  patches.forEach((patch, index) => {
    try {
      applyPatch(document, patch);
    } catch (error) {
      throw new Error(
        `Patch ${index} (${patch.op} ${patch.path}) failed: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error }
      );
    }
  });
  return document;
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

// src/server.ts
var STUDIO_RESOURCE_URI = "ui://cad-studio/studio.html";
var modelIdSchema = z2.string().uuid().describe("Saved model ID from list_models, load_model, or a prior tool result");
var expectedRevisionSchema = z2.number().int().positive().describe("Current revision from load_model; rejects stale edits instead of overwriting them");
var patchPathSchema = z2.string().startsWith("/").min(2).describe(
  "JSON Pointer into /shape, /name, or /color; for example /shape/size/0 or /shape/children/1/radius"
);
var modelPatchSchema = z2.discriminatedUnion("op", [
  z2.object({
    op: z2.enum(["add", "replace"]),
    path: patchPathSchema,
    value: z2.unknown().describe("New JSON value at path")
  }).strict(),
  z2.object({
    op: z2.literal("remove"),
    path: patchPathSchema
  }).strict()
]);
function widgetHtmlCandidates() {
  const candidates = [new URL("./widget.html", import.meta.url)];
  const addSiblingOf = (pathLike) => {
    try {
      candidates.push(pathToFileURL(join(dirname(realpathSync(pathLike)), "widget.html")));
    } catch {
    }
  };
  try {
    addSiblingOf(fileURLToPath(import.meta.url));
  } catch {
  }
  if (process.argv[1]) {
    addSiblingOf(process.argv[1]);
  }
  candidates.push(pathToFileURL(join(process.cwd(), "dist", "widget.html")));
  return candidates;
}
async function loadWidgetHtml() {
  const candidates = widgetHtmlCandidates();
  const attempted = [];
  for (const candidate of candidates) {
    const asPath = fileURLToPath(candidate);
    if (attempted.includes(asPath)) continue;
    attempted.push(asPath);
    try {
      return await readFile(candidate, "utf8");
    } catch {
    }
  }
  throw new Error(
    `Unable to locate widget.html. Looked in: ${attempted.join(", ")}. Run \`npm run build\` if you are working from a source checkout.`
  );
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
    { name: "mcp-cad-studio", version: "0.2.1" },
    {
      instructions: "Use CAD tools to create, inspect, edit, combine, import, export, and delete parametric 3D models. Before changing an existing model, call list_models and load_model, then preserve that modelId: call update_model for direct edits, or generate_model with modelId to regenerate a template in place. Do not create a replacement unless the user asks for a separate model. Prefer update_model.patches for small parameter edits. Call validate_shape before saving complex extrusions or raw meshes. Call studio_ui when the user wants the interactive CAD canvas. Every data tool works without the UI."
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
      description: "Load a saved CAD model, including the modelId, current revision, complete editable parametric definition, and render mesh. Call this before update_model or delete_model.",
      inputSchema: { modelId: modelIdSchema },
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
      description: "Create a separate new CAD model from a declarative parametric shape tree. Do not use this to modify an existing model; load it and call update_model instead. Supports primitives, extrusions, transforms, mesh input, and boolean operations.",
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
          `Created ${model.name} with ${mesh.triangleCount} triangles (model ${model.id}, revision ${model.revision}). For later changes, update this modelId in place with update_model; do not create a replacement.`
        )
      };
    }
  );
  server.registerTool(
    "generate_model",
    {
      title: "Generate CAD model",
      description: "Generate a built-in parametric template: bracket, pipe, gear, enclosure, or bolt. To revise a previously generated model, pass its modelId and expectedRevision to regenerate it in place. Omit modelId only when the user wants a separate new model.",
      inputSchema: {
        modelId: modelIdSchema.describe("Existing model to regenerate in place; omit only to create a new model").optional(),
        expectedRevision: expectedRevisionSchema.optional(),
        name: modelNameSchema.describe("Name for a new model, or optional replacement name when regenerating").optional(),
        template: z2.enum(["bracket", "pipe", "gear", "enclosure", "bolt"]),
        color: colorSchema.describe("Color for a new model, or optional replacement color when regenerating").optional(),
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
    async ({ modelId, expectedRevision, name, template, color, parameters }) => {
      const shape = generatePreset(template, parameters);
      const mesh = await renderShape(shape);
      if (modelId) {
        const current = store.get(modelId);
        const model2 = await store.update(modelId, {
          name: name ?? current.name,
          color: color ?? current.color,
          shape,
          expectedRevision
        });
        return {
          structuredContent: await modelPayload(model2, store, mesh),
          content: content(
            `Regenerated ${model2.name} as a ${template} in place; modelId remains ${model2.id}, revision is now ${model2.revision}.`
          )
        };
      }
      if (!name) {
        throw new Error("name is required when generate_model creates a new model.");
      }
      const model = await store.create({ name, color: color ?? "#60a5fa", shape });
      return {
        structuredContent: await modelPayload(model, store, mesh),
        content: content(
          `Generated ${template} model ${model.name} (${model.id}, revision ${model.revision}) with volume ${mesh.volume.toFixed(2)} mm\xB3. Revise it in place with update_model.`
        )
      };
    }
  );
  server.registerTool(
    "update_model",
    {
      title: "Update CAD model",
      description: "Modify an existing saved model in place while preserving its modelId. Use patches for small edits (example: replace /shape/size/0), or shape to replace the complete definition. Load the model first and pass its expectedRevision. Never call create_model merely to revise an existing model.",
      inputSchema: {
        modelId: modelIdSchema,
        name: modelNameSchema.describe("Optional replacement name").optional(),
        color: colorSchema.describe("Optional replacement six-digit hex color").optional(),
        shape: shapeSchema.describe("Optional complete replacement shape; cannot be combined with patches").optional(),
        patches: z2.array(modelPatchSchema).min(1).max(64).describe(
          "Targeted edits applied in order to the current model. Use add for a new field/array item, replace for an existing value, and remove for an optional field."
        ).optional(),
        expectedRevision: expectedRevisionSchema.optional()
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false
      }
    },
    async ({ modelId, name, color, shape, patches, expectedRevision }) => {
      const current = store.get(modelId);
      if (name === void 0 && color === void 0 && shape === void 0 && patches === void 0) {
        throw new Error(
          "update_model needs at least one change: name, color, shape, or patches."
        );
      }
      if (shape !== void 0 && patches !== void 0) {
        throw new Error(
          "Pass either a complete replacement shape or targeted patches, not both."
        );
      }
      const patched = patches ? applyModelPatches(current, patches) : { name: current.name, color: current.color, shape: current.shape };
      const nextName = modelNameSchema.parse(name ?? patched.name);
      const nextColor = colorSchema.parse(color ?? patched.color);
      const nextShape = shapeSchema.parse(shape ?? patched.shape);
      const mesh = await renderShape(nextShape);
      const model = await store.update(modelId, {
        name: nextName,
        color: nextColor,
        shape: nextShape,
        expectedRevision
      });
      return {
        structuredContent: await modelPayload(model, store, mesh),
        content: content(
          `Updated ${model.name} in place; modelId remains ${model.id}, revision is now ${model.revision}.`
        )
      };
    }
  );
  server.registerTool(
    "validate_shape",
    {
      title: "Validate CAD shape",
      description: "Preflight a complete parametric shape without saving it. Reports static polygon/mesh topology errors and warnings, then asks the CAD kernel to verify the solid. Use this before create_model or update_model for complex shapes.",
      inputSchema: { shape: shapeSchema },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false
      }
    },
    async ({ shape }) => {
      const validation = validateShape(shape);
      if (!validation.valid) {
        return {
          structuredContent: { ...validation },
          content: content(
            `Shape is invalid:
${validation.errors.map((issue) => `- ${issue.path}: ${issue.message}${issue.suggestion ? ` ${issue.suggestion}` : ""}`).join("\n")}`
          )
        };
      }
      try {
        const mesh = await renderShape(shape);
        return {
          structuredContent: { ...validation, mesh },
          content: content(
            `Shape is valid: closed manifold solid with ${mesh.triangleCount} triangles and volume ${mesh.volume.toFixed(2)} mm\xB3.${validation.warnings.length ? ` ${validation.warnings.length} warning(s) are included in structuredContent.` : ""}`
          )
        };
      } catch (error) {
        const issue = {
          severity: "error",
          code: "kernel_rejection",
          path: "$",
          message: error instanceof Error ? error.message : String(error),
          suggestion: "Validate boolean children separately, then simplify coincident or self-intersecting geometry."
        };
        return {
          structuredContent: {
            valid: false,
            errors: [issue],
            warnings: validation.warnings
          },
          content: content(`Shape is invalid: ${issue.message}`)
        };
      }
    }
  );
  server.registerTool(
    "transform_model",
    {
      title: "Transform CAD model",
      description: "Apply an incremental translation, Euler rotation in degrees, or scale to a CAD model.",
      inputSchema: {
        modelId: modelIdSchema,
        translation: z2.tuple([z2.number(), z2.number(), z2.number()]).optional(),
        rotation: z2.tuple([z2.number(), z2.number(), z2.number()]).optional(),
        scale: z2.tuple([
          z2.number().refine((entry) => entry !== 0),
          z2.number().refine((entry) => entry !== 0),
          z2.number().refine((entry) => entry !== 0)
        ]).optional(),
        expectedRevision: expectedRevisionSchema.optional()
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
      description: "Permanently delete one saved CAD model. Call list_models or load_model first to identify the exact modelId, and pass expectedRevision when available to avoid deleting a newer edit.",
      inputSchema: {
        modelId: modelIdSchema,
        expectedRevision: expectedRevisionSchema.optional()
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: false
      }
    },
    async ({ modelId, expectedRevision }) => {
      const deleted = await store.delete(modelId, expectedRevision);
      const nextSummary = store.list()[0];
      const next = nextSummary ? store.get(nextSummary.id) : null;
      return {
        structuredContent: next ? { ...await modelPayload(next, store), deletedModel: summary(deleted) } : {
          models: store.list(),
          deletedModel: summary(deleted),
          activeModel: null,
          mesh: null
        },
        content: content(
          `Deleted ${deleted.name} (${deleted.id}).${next ? ` Selected remaining model ${next.name}.` : " The studio is now empty."}`
        )
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
import { dirname as dirname2 } from "path";
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
  async delete(id, expectedRevision) {
    const model = this.get(id);
    if (expectedRevision !== void 0 && expectedRevision !== model.revision) {
      throw new Error(
        `Revision conflict: expected ${expectedRevision}, current revision is ${model.revision}`
      );
    }
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
      await mkdir(dirname2(dataFile), { recursive: true });
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
  ShapeValidationError,
  assertValidShape,
  createCadStudioServer,
  exportObj,
  exportStl,
  generatePreset,
  importModel,
  renderShape,
  startNetworkServer,
  validateShape
};
//# sourceMappingURL=index.js.map