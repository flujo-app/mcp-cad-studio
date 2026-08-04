import { describe, expect, it } from "vitest";
import { exportStl, renderShape } from "../src/geometry.js";
import { importModel } from "../src/importers.js";
import { generatePreset } from "../src/presets.js";
import { validateShape } from "../src/validation.js";

describe("CAD geometry kernel", () => {
  it("builds exact primitive metrics", async () => {
    const mesh = await renderShape({ kind: "box", size: [10, 20, 30] });
    expect(mesh.volume).toBeCloseTo(6000, 5);
    expect(mesh.surfaceArea).toBeCloseTo(2200, 5);
    expect(mesh.triangleCount).toBe(12);
  });

  it.each(["bracket", "pipe", "gear", "enclosure", "bolt"] as const)(
    "generates a valid %s preset",
    async (template) => {
      const mesh = await renderShape(generatePreset(template));
      expect(mesh.volume).toBeGreaterThan(0);
      expect(mesh.triangleCount).toBeGreaterThan(10);
    },
  );

  it("round-trips an ASCII STL through the importer", async () => {
    const source = { kind: "box", size: [12, 9, 7] } as const;
    const stl = await exportStl(
      { kind: source.kind, size: [...source.size] },
      "test-box",
    );
    const imported = importModel("stl", stl, "text");
    const mesh = await renderShape(imported);
    expect(mesh.volume).toBeCloseTo(756, 4);
    expect(mesh.triangleCount).toBe(12);
  });

  it("reports actionable static diagnostics for non-manifold meshes", async () => {
    const openTriangle = {
      kind: "mesh",
      vertices: [0, 0, 0, 10, 0, 0, 0, 10, 0],
      triangles: [0, 1, 2],
    };
    const validation = validateShape(openTriangle);
    expect(validation.valid).toBe(false);
    expect(validation.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "mesh_open_boundary",
          path: "$.triangles",
        }),
      ]),
    );
    await expect(renderShape(openTriangle as never)).rejects.toThrow(
      /exactly two triangles/i,
    );
  });

  it("rejects malformed extrusion outlines before invoking the kernel", () => {
    const validation = validateShape({
      kind: "extrude",
      points: [
        [0, 0],
        [10, 10],
        [0, 10],
        [10, 0],
      ],
      height: 5,
    });
    expect(validation.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "polygon_self_intersection" }),
        expect.objectContaining({ code: "polygon_zero_area" }),
      ]),
    );
  });

  it("rejects unsupported shape fields instead of silently discarding them", () => {
    const validation = validateShape({
      kind: "sphere",
      radius: 5,
      diameter: 10,
    });
    expect(validation.valid).toBe(false);
    expect(validation.errors[0]).toMatchObject({
      code: "schema_unrecognized_keys",
      path: "$",
    });
  });
});
