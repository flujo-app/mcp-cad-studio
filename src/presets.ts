import type { GenerateTemplate, ShapeNode, Vec2 } from "./types.js";

export interface TemplateParameters {
  width?: number;
  depth?: number;
  height?: number;
  thickness?: number;
  radius?: number;
  holeRadius?: number;
  teeth?: number;
}

const value = (
  input: number | undefined,
  fallback: number,
  min = 0.1,
  max = 10_000,
) => Math.min(max, Math.max(min, input ?? fallback));

export function generatePreset(
  template: GenerateTemplate,
  parameters: TemplateParameters = {},
): ShapeNode {
  switch (template) {
    case "pipe": {
      const height = value(parameters.height, 40);
      const radius = value(parameters.radius, 15);
      const thickness = Math.min(
        radius * 0.9,
        value(parameters.thickness, 2.5),
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
            transform: { translation: [0, 0, -1] },
          },
        ],
      };
    }
    case "gear": {
      const radius = value(parameters.radius, 22);
      const height = value(parameters.height, 6);
      const teeth = Math.round(value(parameters.teeth, 18, 6, 80));
      const holeRadius = Math.min(
        radius * 0.7,
        value(parameters.holeRadius, 5),
      );
      const points: Vec2[] = [];
      for (let index = 0; index < teeth * 4; index += 1) {
        const angle = (index / (teeth * 4)) * Math.PI * 2;
        const toothPhase = index % 4;
        const distance =
          toothPhase === 1 || toothPhase === 2 ? radius * 1.14 : radius;
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
            transform: { translation: [0, 0, -1] },
          },
        ],
      };
    }
    case "bracket": {
      const width = value(parameters.width, 50);
      const depth = value(parameters.depth, 30);
      const height = value(parameters.height, 45);
      const thickness = Math.min(
        Math.min(depth, height) * 0.4,
        value(parameters.thickness, 5),
      );
      const holeRadius = value(parameters.holeRadius, 3.5);
      const solid: ShapeNode = {
        kind: "union",
        children: [
          { kind: "box", size: [width, depth, thickness] },
          { kind: "box", size: [width, thickness, height] },
        ],
      };
      const holeA: ShapeNode = {
        kind: "cylinder",
        height: thickness + 2,
        radius: holeRadius,
        segments: 40,
        transform: {
          translation: [width * 0.25, depth * 0.55, -1],
        },
      };
      const holeB: ShapeNode = {
        ...holeA,
        transform: { translation: [width * 0.75, depth * 0.55, -1] },
      };
      return { kind: "difference", children: [solid, holeA, holeB] };
    }
    case "enclosure": {
      const width = value(parameters.width, 70);
      const depth = value(parameters.depth, 48);
      const height = value(parameters.height, 24);
      const thickness = Math.min(
        Math.min(width, depth, height) * 0.3,
        value(parameters.thickness, 2.5),
      );
      return {
        kind: "difference",
        children: [
          { kind: "box", size: [width, depth, height] },
          {
            kind: "box",
            size: [width - thickness * 2, depth - thickness * 2, height],
            transform: { translation: [thickness, thickness, thickness] },
          },
        ],
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
            transform: { translation: [0, 0, height] },
          },
        ],
      };
    }
  }
}
