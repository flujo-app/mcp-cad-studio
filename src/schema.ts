import { z } from "zod";
import type { ShapeNode } from "./types.js";

const finiteNumber = z.number().finite();
const positive = finiteNumber.positive().max(100_000);
const vec2 = z.tuple([finiteNumber, finiteNumber]);
const vec3 = z.tuple([finiteNumber, finiteNumber, finiteNumber]);
const transform = z
  .object({
    translation: vec3.optional(),
    rotation: vec3.optional(),
    scale: z
      .tuple([
        finiteNumber.refine((value) => value !== 0, "Scale cannot be zero"),
        finiteNumber.refine((value) => value !== 0, "Scale cannot be zero"),
        finiteNumber.refine((value) => value !== 0, "Scale cannot be zero"),
      ])
      .optional(),
  })
  .strict();

const base = { transform: transform.optional() };

export const shapeSchema: z.ZodType<ShapeNode> = z.lazy(() =>
  z.discriminatedUnion("kind", [
    z.object({
      ...base,
      kind: z.literal("box"),
      size: z.tuple([positive, positive, positive]),
      center: z.boolean().optional(),
    }),
    z.object({
      ...base,
      kind: z.literal("sphere"),
      radius: positive,
      segments: z.number().int().min(8).max(256).optional(),
    }),
    z.object({
      ...base,
      kind: z.literal("cylinder"),
      height: positive,
      radius: positive,
      segments: z.number().int().min(3).max(256).optional(),
      center: z.boolean().optional(),
    }),
    z.object({
      ...base,
      kind: z.literal("cone"),
      height: positive,
      radiusBottom: positive,
      radiusTop: finiteNumber.min(0).max(100_000),
      segments: z.number().int().min(3).max(256).optional(),
      center: z.boolean().optional(),
    }),
    z.object({
      ...base,
      kind: z.literal("extrude"),
      points: z.array(vec2).min(3).max(2_048),
      height: positive,
      twist: finiteNumber.min(-10_000).max(10_000).optional(),
      scaleTop: vec2.optional(),
      center: z.boolean().optional(),
    }),
    z.object({
      ...base,
      kind: z.literal("mesh"),
      vertices: z.array(finiteNumber).min(9).max(900_000),
      triangles: z.array(z.number().int().nonnegative()).min(3).max(900_000),
    }),
    z.object({
      ...base,
      kind: z.enum(["union", "difference", "intersection"]),
      children: z.array(shapeSchema).min(2).max(64),
    }),
  ]),
);

export const colorSchema = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/, "Use a six-digit hex color such as #4f8cff");

export const modelNameSchema = z.string().trim().min(1).max(120);
