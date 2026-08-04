import { describe, expect, it } from "vitest";
import { exportStl, renderShape } from "../src/geometry.js";
import { importModel } from "../src/importers.js";
import { generatePreset } from "../src/presets.js";

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
});
