import createManifoldModule, {
  type Manifold as ManifoldInstance,
  type ManifoldToplevel,
} from "manifold-3d";
import type { RenderMesh, ShapeNode, Transform, Vec3 } from "./types.js";
import { assertValidShape } from "./validation.js";

let modulePromise: Promise<ManifoldToplevel> | undefined;

export async function getManifoldModule(): Promise<ManifoldToplevel> {
  modulePromise ??= createManifoldModule().then((module) => {
    module.setup();
    return module;
  });
  return modulePromise;
}

function applyTransform(
  source: ManifoldInstance,
  transform: Transform | undefined,
): ManifoldInstance {
  if (!transform) return source;

  let result = source;
  const replace = (next: ManifoldInstance) => {
    if (next !== result) result.delete();
    result = next;
  };

  if (transform.scale) replace(result.scale(transform.scale));
  if (transform.rotation) replace(result.rotate(transform.rotation));
  if (transform.translation) replace(result.translate(transform.translation));
  return result;
}

const kernelStatusHelp: Record<string, string> = {
  NonFiniteVertex:
    "One or more calculated vertices are NaN or infinite. Check dimensions, transforms, and mesh coordinates.",
  NotManifold:
    "The result is not a closed 2-manifold solid. Mesh edges must have exactly two oppositely wound faces; extrusion outlines must not repeat or cross; boolean operands should have clean closed volumes.",
  VertexOutOfBounds:
    "A triangle references a vertex outside the mesh vertex array.",
  PropertiesWrongLength:
    "The mesh vertex-property array does not contain complete XYZ triples.",
  MissingPositionProperties:
    "The mesh is missing XYZ position properties.",
  MergeVectorsDifferentLengths:
    "The mesh repair metadata is inconsistent.",
  MergeIndexOutOfBounds:
    "The mesh repair metadata references a missing vertex.",
  TransformWrongLength:
    "A transform does not contain the required number of values.",
  RunIndexWrongLength: "The imported mesh contains invalid run metadata.",
  FaceIDWrongLength: "The imported mesh contains invalid face metadata.",
  InvalidConstruction:
    "The requested solid is geometrically invalid. Check for collapsed dimensions, coincident surfaces, and self-intersections.",
  ResultTooLarge:
    "The result exceeds the CAD kernel's size limit. Reduce segments, polygon points, twist, or boolean complexity.",
  InvalidTangents: "The imported mesh contains invalid tangent data.",
  Cancelled: "The CAD kernel operation was cancelled.",
};

function kernelStatusError(status: string): Error {
  const help = kernelStatusHelp[status] ??
    "Simplify the shape and validate each child solid independently.";
  return new Error(
    `CAD kernel rejected the shape (${status}). ${help} ` +
      "Use validate_shape before saving to get structured preflight diagnostics.",
  );
}

function friendlyKernelError(error: unknown): Error {
  if (error instanceof Error && error.message.startsWith("CAD kernel rejected")) {
    return error;
  }
  const message = error instanceof Error ? error.message : String(error);
  if (/not[ _-]?manifold/i.test(message)) {
    return kernelStatusError("NotManifold");
  }
  return new Error(
    `CAD kernel could not build the shape: ${message}. ` +
      "Use validate_shape before saving to get structured preflight diagnostics.",
    { cause: error },
  );
}

async function buildNode(
  shape: ShapeNode,
  module: ManifoldToplevel,
): Promise<ManifoldInstance> {
  const { Manifold, Mesh } = module;
  let result: ManifoldInstance;

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
        shape.center ?? false,
      );
      break;
    case "cone":
      result = Manifold.cylinder(
        shape.height,
        shape.radiusBottom,
        shape.radiusTop,
        shape.segments ?? 48,
        shape.center ?? false,
      );
      break;
    case "extrude":
      result = Manifold.extrude(
        shape.points,
        shape.height,
        Math.max(0, Math.ceil(Math.abs(shape.twist ?? 0) / 15) - 1),
        shape.twist ?? 0,
        shape.scaleTop ?? [1, 1],
        shape.center ?? false,
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
        triVerts: Uint32Array.from(shape.triangles),
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
          let next: ManifoldInstance;
          try {
            next =
              shape.kind === "union"
                ? result.add(other)
                : shape.kind === "difference"
                  ? result.subtract(other)
                  : result.intersect(other);
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

export async function buildSolid(shape: ShapeNode): Promise<ManifoldInstance> {
  const validated = assertValidShape(shape);
  const module = await getManifoldModule();
  let solid: ManifoldInstance;
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

export async function renderShape(shape: ShapeNode): Promise<RenderMesh> {
  const solid = await buildSolid(shape);
  try {
    const mesh = solid.getMesh();
    const positions: number[] = [];
    for (let vertex = 0; vertex < mesh.numVert; vertex += 1) {
      const offset = vertex * mesh.numProp;
      positions.push(
        mesh.vertProperties[offset] ?? 0,
        mesh.vertProperties[offset + 1] ?? 0,
        mesh.vertProperties[offset + 2] ?? 0,
      );
    }
    const bounds = solid.boundingBox();
    return {
      positions,
      triangles: Array.from(mesh.triVerts),
      bounds: {
        min: Array.from(bounds.min) as Vec3,
        max: Array.from(bounds.max) as Vec3,
      },
      volume: solid.volume(),
      surfaceArea: solid.surfaceArea(),
      vertexCount: mesh.numVert,
      triangleCount: mesh.numTri,
    };
  } finally {
    solid.delete();
  }
}

export async function exportObj(shape: ShapeNode, name: string): Promise<string> {
  const mesh = await renderShape(shape);
  const lines = [`# ${name} exported by MCP CAD Studio`];
  for (let index = 0; index < mesh.positions.length; index += 3) {
    lines.push(
      `v ${mesh.positions[index]} ${mesh.positions[index + 1]} ${mesh.positions[index + 2]}`,
    );
  }
  for (let index = 0; index < mesh.triangles.length; index += 3) {
    lines.push(
      `f ${(mesh.triangles[index] ?? 0) + 1} ${(mesh.triangles[index + 1] ?? 0) + 1} ${(mesh.triangles[index + 2] ?? 0) + 1}`,
    );
  }
  return `${lines.join("\n")}\n`;
}

function normal(a: Vec3, b: Vec3, c: Vec3): Vec3 {
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

export async function exportStl(shape: ShapeNode, name: string): Promise<string> {
  const mesh = await renderShape(shape);
  const lines = [`solid ${name.replace(/[^a-zA-Z0-9_-]/g, "_")}`];
  const vertex = (index: number): Vec3 => {
    const offset = index * 3;
    return [
      mesh.positions[offset] ?? 0,
      mesh.positions[offset + 1] ?? 0,
      mesh.positions[offset + 2] ?? 0,
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
      "  endfacet",
    );
  }
  lines.push("endsolid");
  return `${lines.join("\n")}\n`;
}
