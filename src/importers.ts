import type { ShapeNode, Vec3 } from "./types.js";

const MAX_BYTES = 25 * 1024 * 1024;

function decode(data: string, encoding: "text" | "base64"): Uint8Array {
  const bytes =
    encoding === "base64"
      ? Uint8Array.from(Buffer.from(data, "base64"))
      : new TextEncoder().encode(data);
  if (bytes.byteLength > MAX_BYTES) {
    throw new Error("Imported model exceeds the 25 MiB limit");
  }
  return bytes;
}

function meshShape(vertices: number[], triangles: number[]): ShapeNode {
  if (vertices.length < 9 || triangles.length < 3) {
    throw new Error("No triangles were found in the imported model");
  }
  return { kind: "mesh", vertices, triangles };
}

function parseObj(text: string): ShapeNode {
  const sourceVertices: Vec3[] = [];
  const vertices: number[] = [];
  const triangles: number[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const parts = line.split(/\s+/);
    if (parts[0] === "v" && parts.length >= 4) {
      const point = parts.slice(1, 4).map(Number) as Vec3;
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

function parseBinaryStl(bytes: Uint8Array): ShapeNode {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getUint32(80, true);
  if (84 + count * 50 !== bytes.byteLength) throw new Error("Invalid binary STL");
  const vertices: number[] = [];
  const triangles: number[] = [];
  for (let triangle = 0; triangle < count; triangle += 1) {
    const base = 84 + triangle * 50 + 12;
    for (let corner = 0; corner < 3; corner += 1) {
      const offset = base + corner * 12;
      vertices.push(
        view.getFloat32(offset, true),
        view.getFloat32(offset + 4, true),
        view.getFloat32(offset + 8, true),
      );
      triangles.push(triangles.length);
    }
  }
  return meshShape(vertices, triangles);
}

function parseAsciiStl(text: string): ShapeNode {
  const vertices: number[] = [];
  const triangles: number[] = [];
  const matches = text.matchAll(
    /\bvertex\s+([-+\d.eE]+)\s+([-+\d.eE]+)\s+([-+\d.eE]+)/g,
  );
  for (const match of matches) {
    vertices.push(Number(match[1]), Number(match[2]), Number(match[3]));
    triangles.push(triangles.length);
  }
  if (triangles.length % 3 !== 0) throw new Error("ASCII STL has incomplete facets");
  return meshShape(vertices, triangles);
}

export function importModel(
  format: "stl" | "obj",
  data: string,
  encoding: "text" | "base64",
): ShapeNode {
  const bytes = decode(data, encoding);
  if (format === "obj") return parseObj(new TextDecoder().decode(bytes));
  const binary =
    bytes.byteLength >= 84 &&
    84 + new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(80, true) * 50 ===
      bytes.byteLength;
  return binary
    ? parseBinaryStl(bytes)
    : parseAsciiStl(new TextDecoder().decode(bytes));
}
