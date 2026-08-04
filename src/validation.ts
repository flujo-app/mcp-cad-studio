import { shapeSchema } from "./schema.js";
import type { ShapeNode, Vec2, Vec3 } from "./types.js";

export type ShapeIssueSeverity = "error" | "warning";

export interface ShapeIssue {
  severity: ShapeIssueSeverity;
  code: string;
  path: string;
  message: string;
  suggestion?: string;
}

export interface ShapeValidationResult {
  valid: boolean;
  errors: ShapeIssue[];
  warnings: ShapeIssue[];
}

const MAX_SHAPE_DEPTH = 24;
const MAX_SHAPE_NODES = 256;
const MAX_EXTRUSION_VERTICES = 500_000;

function jsonPath(parts: readonly PropertyKey[]): string {
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

function childPath(path: string, property: string | number): string {
  return typeof property === "number" ? `${path}[${property}]` : `${path}.${property}`;
}

function samePoint(left: Vec2, right: Vec2, tolerance: number): boolean {
  return (
    Math.abs(left[0] - right[0]) <= tolerance &&
    Math.abs(left[1] - right[1]) <= tolerance
  );
}

function cross2(a: Vec2, b: Vec2, c: Vec2): number {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}

function pointOnSegment(
  point: Vec2,
  start: Vec2,
  end: Vec2,
  tolerance: number,
): boolean {
  return (
    Math.abs(cross2(start, end, point)) <= tolerance &&
    point[0] >= Math.min(start[0], end[0]) - tolerance &&
    point[0] <= Math.max(start[0], end[0]) + tolerance &&
    point[1] >= Math.min(start[1], end[1]) - tolerance &&
    point[1] <= Math.max(start[1], end[1]) + tolerance
  );
}

function segmentsIntersect(
  a: Vec2,
  b: Vec2,
  c: Vec2,
  d: Vec2,
  tolerance: number,
): boolean {
  const abC = cross2(a, b, c);
  const abD = cross2(a, b, d);
  const cdA = cross2(c, d, a);
  const cdB = cross2(c, d, b);
  if (
    ((abC > tolerance && abD < -tolerance) ||
      (abC < -tolerance && abD > tolerance)) &&
    ((cdA > tolerance && cdB < -tolerance) ||
      (cdA < -tolerance && cdB > tolerance))
  ) {
    return true;
  }
  return (
    (Math.abs(abC) <= tolerance && pointOnSegment(c, a, b, tolerance)) ||
    (Math.abs(abD) <= tolerance && pointOnSegment(d, a, b, tolerance)) ||
    (Math.abs(cdA) <= tolerance && pointOnSegment(a, c, d, tolerance)) ||
    (Math.abs(cdB) <= tolerance && pointOnSegment(b, c, d, tolerance))
  );
}

function validatePolygon(points: Vec2[], path: string, issues: ShapeIssue[]): void {
  const coordinateScale = Math.max(
    1,
    ...points.flatMap((point) => [Math.abs(point[0]), Math.abs(point[1])]),
  );
  const pointTolerance = coordinateScale * 1e-10;
  const areaTolerance = coordinateScale * coordinateScale * 1e-12;

  if (samePoint(points[0]!, points.at(-1)!, pointTolerance)) {
    issues.push({
      severity: "error",
      code: "polygon_repeated_closing_point",
      path,
      message: "The first polygon point is repeated as the last point.",
      suggestion: "Remove the final point; extrusion polygons are closed automatically.",
    });
  }

  for (let index = 0; index < points.length; index += 1) {
    const next = (index + 1) % points.length;
    if (samePoint(points[index]!, points[next]!, pointTolerance)) {
      issues.push({
        severity: "error",
        code: "polygon_zero_length_edge",
        path: childPath(path, next),
        message: `Polygon points ${index} and ${next} create a zero-length edge.`,
        suggestion: "Remove one of the duplicate adjacent points.",
      });
      break;
    }
  }

  let twiceArea = 0;
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index]!;
    const next = points[(index + 1) % points.length]!;
    twiceArea += current[0] * next[1] - next[0] * current[1];
  }
  if (Math.abs(twiceArea) <= areaTolerance) {
    issues.push({
      severity: "error",
      code: "polygon_zero_area",
      path,
      message: "The extrusion polygon has zero or near-zero area.",
      suggestion: "Use at least three non-collinear boundary points.",
    });
  }

  let foundIntersection = false;
  for (let left = 0; left < points.length && !foundIntersection; left += 1) {
    const leftNext = (left + 1) % points.length;
    for (let right = left + 1; right < points.length; right += 1) {
      const rightNext = (right + 1) % points.length;
      if (left === right || leftNext === right || rightNext === left) continue;
      if (
        segmentsIntersect(
          points[left]!,
          points[leftNext]!,
          points[right]!,
          points[rightNext]!,
          areaTolerance,
        )
      ) {
        issues.push({
          severity: "error",
          code: "polygon_self_intersection",
          path,
          message: `Polygon edges ${left}–${leftNext} and ${right}–${rightNext} intersect.`,
          suggestion:
            "Reorder or move the boundary points so the polygon does not cross itself.",
        });
        foundIntersection = true;
        break;
      }
    }
  }
}

interface MeshFace {
  indices: [number, number, number];
  welded: [number, number, number];
}

interface MeshEdge {
  faces: number[];
  direction: number;
  vertices: [number, number];
}

function meshPoint(vertices: number[], index: number): Vec3 {
  const offset = index * 3;
  return [vertices[offset]!, vertices[offset + 1]!, vertices[offset + 2]!];
}

function triangleDoubleArea(a: Vec3, b: Vec3, c: Vec3): number {
  const ab: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const ac: Vec3 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  return Math.hypot(
    ab[1] * ac[2] - ab[2] * ac[1],
    ab[2] * ac[0] - ab[0] * ac[2],
    ab[0] * ac[1] - ab[1] * ac[0],
  );
}

function validateMesh(shape: Extract<ShapeNode, { kind: "mesh" }>, path: string, issues: ShapeIssue[]): void {
  if (shape.vertices.length % 3 !== 0) {
    issues.push({
      severity: "error",
      code: "mesh_incomplete_vertex",
      path: childPath(path, "vertices"),
      message: "The vertices array length must be divisible by 3 (x, y, z).",
      suggestion: "Add or remove values so every vertex has exactly three coordinates.",
    });
  }
  if (shape.triangles.length % 3 !== 0) {
    issues.push({
      severity: "error",
      code: "mesh_incomplete_triangle",
      path: childPath(path, "triangles"),
      message: "The triangles array length must be divisible by 3.",
      suggestion: "Provide exactly three vertex indices per triangle.",
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
      message: `Vertex index ${shape.triangles[invalidIndex]} is outside the 0–${vertexCount - 1} range.`,
      suggestion: "Use only indices that refer to entries in the vertices array.",
    });
    return;
  }

  const float32 = new Float32Array(shape.vertices);
  const weldedByPosition = new Map<string, number>();
  const weldedIndices: number[] = [];
  for (let vertex = 0; vertex < vertexCount; vertex += 1) {
    const offset = vertex * 3;
    const key = `${float32[offset]},${float32[offset + 1]},${float32[offset + 2]}`;
    let welded = weldedByPosition.get(key);
    if (welded === undefined) {
      welded = weldedByPosition.size;
      weldedByPosition.set(key, welded);
    }
    weldedIndices.push(welded);
  }

  const coordinates = Array.from(float32);
  const boundsMin: Vec3 = [Infinity, Infinity, Infinity];
  const boundsMax: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (let vertex = 0; vertex < vertexCount; vertex += 1) {
    const point = meshPoint(coordinates, vertex);
    for (const axis of [0, 1, 2] as const) {
      boundsMin[axis] = Math.min(boundsMin[axis], point[axis]);
      boundsMax[axis] = Math.max(boundsMax[axis], point[axis]);
    }
  }
  const diagonal = Math.hypot(
    boundsMax[0] - boundsMin[0],
    boundsMax[1] - boundsMin[1],
    boundsMax[2] - boundsMin[2],
  );
  const areaTolerance = Math.max(1, diagonal * diagonal) * 1e-12;
  const faces: MeshFace[] = [];
  const edges = new Map<string, MeshEdge>();
  let degenerateFaces = 0;

  for (let offset = 0; offset < shape.triangles.length; offset += 3) {
    const indices = shape.triangles.slice(offset, offset + 3) as [number, number, number];
    const welded = indices.map((index) => weldedIndices[index]!) as [number, number, number];
    const faceIndex = faces.length;
    faces.push({ indices, welded });
    if (
      new Set(welded).size !== 3 ||
      triangleDoubleArea(
        meshPoint(coordinates, indices[0]),
        meshPoint(coordinates, indices[1]),
        meshPoint(coordinates, indices[2]),
      ) <= areaTolerance
    ) {
      degenerateFaces += 1;
      continue;
    }
    for (let corner = 0; corner < 3; corner += 1) {
      const from = welded[corner]!;
      const to = welded[(corner + 1) % 3]!;
      const low = Math.min(from, to);
      const high = Math.max(from, to);
      const key = `${low}:${high}`;
      const edge = edges.get(key) ?? {
        faces: [],
        direction: 0,
        vertices: [low, high] as [number, number],
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
      suggestion: "Remove collapsed faces and ensure every triangle uses three non-collinear vertices.",
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
      suggestion: "Cap every hole; a solid mesh requires exactly two triangles around every edge.",
    });
  }
  if (overusedEdges > 0) {
    issues.push({
      severity: "error",
      code: "mesh_non_manifold_edges",
      path: childPath(path, "triangles"),
      message: `${overusedEdges} mesh edge${overusedEdges === 1 ? " is" : "s are"} shared by more than two triangles.`,
      suggestion: "Split or remove overlapping faces so exactly two triangles share each edge.",
    });
  }
  if (misorientedEdges > 0) {
    issues.push({
      severity: "error",
      code: "mesh_inconsistent_winding",
      path: childPath(path, "triangles"),
      message: `${misorientedEdges} shared edge${misorientedEdges === 1 ? " has" : "s have"} triangles wound in the same direction.`,
      suggestion: "Reverse the index order of inconsistent triangles so all faces point outward.",
    });
  }

  if (
    boundaryEdges === 0 &&
    overusedEdges === 0 &&
    degenerateFaces === 0 &&
    faces.length > 0
  ) {
    const facesByVertex = new Map<number, Set<number>>();
    for (let faceIndex = 0; faceIndex < faces.length; faceIndex += 1) {
      for (const vertex of faces[faceIndex]!.welded) {
        const entries = facesByVertex.get(vertex) ?? new Set<number>();
        entries.add(faceIndex);
        facesByVertex.set(vertex, entries);
      }
    }
    const adjacencyByVertex = new Map<number, Map<number, Set<number>>>();
    for (const edge of edges.values()) {
      if (edge.faces.length !== 2) continue;
      const [left, right] = edge.faces as [number, number];
      for (const vertex of edge.vertices) {
        const adjacency = adjacencyByVertex.get(vertex) ?? new Map<number, Set<number>>();
        const leftNeighbors = adjacency.get(left) ?? new Set<number>();
        const rightNeighbors = adjacency.get(right) ?? new Set<number>();
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
      const adjacency = adjacencyByVertex.get(vertex) ?? new Map<number, Set<number>>();
      const first = incident.values().next().value as number | undefined;
      if (first === undefined) continue;
      const reached = new Set<number>([first]);
      const queue = [first];
      while (queue.length > 0) {
        const face = queue.pop()!;
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
        suggestion: "Do not join otherwise separate closed shells at only a point.",
      });
    }
  }
}

function semanticIssues(shape: ShapeNode): ShapeIssue[] {
  const issues: ShapeIssue[] = [];
  let nodeCount = 0;
  const visit = (node: ShapeNode, path: string, depth: number): void => {
    nodeCount += 1;
    if (depth > MAX_SHAPE_DEPTH) {
      issues.push({
        severity: "error",
        code: "shape_too_deep",
        path,
        message: `The shape tree exceeds the maximum depth of ${MAX_SHAPE_DEPTH}.`,
        suggestion: "Flatten nested boolean groups where possible.",
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
          suggestion: "Simplify repeated detail or split it across separate models.",
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
          suggestion: "Reduce the point count or twist angle, or build the detail with simpler solids.",
        });
      }
      if (node.scaleTop?.some((entry) => entry < 0)) {
        issues.push({
          severity: "warning",
          code: "extrusion_negative_top_scale",
          path: childPath(path, "scaleTop"),
          message: "A negative top scale can invert the profile through itself.",
          suggestion: "Prefer non-negative top scale values unless the inversion is intentional.",
        });
      }
    } else if (node.kind === "mesh") {
      validateMesh(node, path, issues);
    } else if (
      node.kind === "union" ||
      node.kind === "difference" ||
      node.kind === "intersection"
    ) {
      node.children.forEach((child, index) =>
        visit(child, childPath(childPath(path, "children"), index), depth + 1),
      );
    }
  };
  visit(shape, "$", 0);
  return issues;
}

export function validateShape(input: unknown): ShapeValidationResult {
  const parsed = shapeSchema.safeParse(input);
  const issues: ShapeIssue[] = [];
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      issues.push({
        severity: "error",
        code: `schema_${issue.code}`,
        path: jsonPath(issue.path),
        message: issue.message,
      });
    }
  } else {
    issues.push(...semanticIssues(parsed.data));
  }
  const errors = issues.filter((issue) => issue.severity === "error");
  return {
    valid: errors.length === 0,
    errors,
    warnings: issues.filter((issue) => issue.severity === "warning"),
  };
}

export class ShapeValidationError extends Error {
  readonly issues: ShapeIssue[];

  constructor(issues: ShapeIssue[]) {
    const details = issues
      .slice(0, 8)
      .map(
        (issue) =>
          `- ${issue.path}: ${issue.message}${issue.suggestion ? ` ${issue.suggestion}` : ""}`,
      )
      .join("\n");
    const remaining = Math.max(0, issues.length - 8);
    super(
      `Shape validation failed with ${issues.length} error${issues.length === 1 ? "" : "s"}:\n${details}${remaining ? `\n- …and ${remaining} more.` : ""}`,
    );
    this.name = "ShapeValidationError";
    this.issues = issues;
  }
}

export function assertValidShape(input: unknown): ShapeNode {
  const result = validateShape(input);
  if (!result.valid) throw new ShapeValidationError(result.errors);
  return input as ShapeNode;
}
