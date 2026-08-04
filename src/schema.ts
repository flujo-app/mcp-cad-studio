import { z } from "zod";
import type { ShapeNode } from "./types.js";

const finiteNumber = z.number().finite();
const positive = finiteNumber.positive().max(100_000);
const vec2 = z.tuple([finiteNumber, finiteNumber]);
const vec3 = z.tuple([finiteNumber, finiteNumber, finiteNumber]);
const transform = z
  .object({
    translation: vec3
      .describe("XYZ translation, in the studio's millimeter units")
      .optional(),
    rotation: vec3.describe("XYZ Euler rotation in degrees").optional(),
    scale: z
      .tuple([
        finiteNumber.refine((value) => value !== 0, "Scale cannot be zero"),
        finiteNumber.refine((value) => value !== 0, "Scale cannot be zero"),
        finiteNumber.refine((value) => value !== 0, "Scale cannot be zero"),
      ])
      .describe("Non-zero XYZ scale factors")
      .optional(),
  })
  .strict()
  .describe("Optional transform applied after constructing this node");

const base = { transform: transform.optional() };

export const shapeSchema: z.ZodType<ShapeNode> = z.lazy(() =>
  z.discriminatedUnion("kind", [
    z
      .object({
        ...base,
        kind: z.literal("box"),
        size: z
          .tuple([positive, positive, positive])
          .describe("Positive XYZ dimensions"),
        center: z
          .boolean()
          .describe("Center the box on the origin instead of using its minimum corner")
          .optional(),
      })
      .strict()
      .describe("Rectangular solid"),
    z
      .object({
        ...base,
        kind: z.literal("sphere"),
        radius: positive.describe("Positive radius"),
        segments: z
          .number()
          .int()
          .min(8)
          .max(256)
          .describe("Surface resolution; normally 32–64")
          .optional(),
      })
      .strict()
      .describe("Spherical solid centered on the origin"),
    z
      .object({
        ...base,
        kind: z.literal("cylinder"),
        height: positive.describe("Positive Z-axis height"),
        radius: positive.describe("Positive radius"),
        segments: z
          .number()
          .int()
          .min(3)
          .max(256)
          .describe("Radial resolution; normally 32–64")
          .optional(),
        center: z
          .boolean()
          .describe("Center the height on Z=0 instead of starting at Z=0")
          .optional(),
      })
      .strict()
      .describe("Cylindrical solid aligned to the Z axis"),
    z
      .object({
        ...base,
        kind: z.literal("cone"),
        height: positive.describe("Positive Z-axis height"),
        radiusBottom: positive.describe("Positive bottom radius"),
        radiusTop: finiteNumber
          .min(0)
          .max(100_000)
          .describe("Top radius; use 0 for a pointed cone"),
        segments: z
          .number()
          .int()
          .min(3)
          .max(256)
          .describe("Radial resolution; normally 32–64")
          .optional(),
        center: z
          .boolean()
          .describe("Center the height on Z=0 instead of starting at Z=0")
          .optional(),
      })
      .strict()
      .describe("Cone or conical frustum aligned to the Z axis"),
    z
      .object({
        ...base,
        kind: z.literal("extrude"),
        points: z
          .array(vec2)
          .min(3)
          .max(2_048)
          .describe(
            "Ordered XY boundary of one simple polygon. Do not repeat the first point at the end; the boundary closes automatically.",
          ),
        height: positive.describe("Positive extrusion height along Z"),
        twist: finiteNumber
          .min(-10_000)
          .max(10_000)
          .describe("Optional total twist in degrees")
          .optional(),
        scaleTop: vec2
          .describe("Optional XY scale factors at the top of the extrusion")
          .optional(),
        center: z
          .boolean()
          .describe("Center the height on Z=0 instead of starting at Z=0")
          .optional(),
      })
      .strict()
      .describe("Solid extrusion of a simple, non-self-intersecting XY polygon"),
    z
      .object({
        ...base,
        kind: z.literal("mesh"),
        vertices: z
          .array(finiteNumber)
          .min(9)
          .max(900_000)
          .describe("Flat XYZ coordinate triples"),
        triangles: z
          .array(z.number().int().nonnegative())
          .min(3)
          .max(900_000)
          .describe(
            "Flat triples of zero-based vertex indices, wound counter-clockwise from outside. The mesh must be closed and manifold.",
          ),
      })
      .strict()
      .describe("Closed, consistently wound, manifold triangle mesh"),
    z
      .object({
        ...base,
        kind: z.enum(["union", "difference", "intersection"]),
        children: z
          .array(shapeSchema)
          .min(2)
          .max(64)
          .describe(
            "Operand shapes. For difference, the first child is the base and all later children are subtracted.",
          ),
      })
      .strict()
      .describe("Boolean operation over two or more closed solids"),
  ]).describe(
    "Complete declarative solid definition. Every object is strict; use only documented fields.",
  ),
);

export const colorSchema = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/, "Use a six-digit hex color such as #4f8cff");

export const modelNameSchema = z.string().trim().min(1).max(120);
