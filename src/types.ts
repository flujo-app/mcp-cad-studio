export type Vec2 = [number, number];
export type Vec3 = [number, number, number];

export interface Transform {
  translation?: Vec3;
  rotation?: Vec3;
  scale?: Vec3;
}

interface ShapeBase {
  transform?: Transform;
}

export type ShapeNode =
  | (ShapeBase & { kind: "box"; size: Vec3; center?: boolean })
  | (ShapeBase & { kind: "sphere"; radius: number; segments?: number })
  | (ShapeBase & {
      kind: "cylinder";
      height: number;
      radius: number;
      segments?: number;
      center?: boolean;
    })
  | (ShapeBase & {
      kind: "cone";
      height: number;
      radiusBottom: number;
      radiusTop: number;
      segments?: number;
      center?: boolean;
    })
  | (ShapeBase & {
      kind: "extrude";
      points: Vec2[];
      height: number;
      twist?: number;
      scaleTop?: Vec2;
      center?: boolean;
    })
  | (ShapeBase & {
      kind: "mesh";
      vertices: number[];
      triangles: number[];
    })
  | (ShapeBase & {
      kind: "union" | "difference" | "intersection";
      children: ShapeNode[];
    });

export interface CadModel {
  id: string;
  name: string;
  color: string;
  shape: ShapeNode;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface ModelSummary {
  id: string;
  name: string;
  color: string;
  revision: number;
  updatedAt: string;
  kind: ShapeNode["kind"];
}

export interface RenderMesh {
  positions: number[];
  triangles: number[];
  bounds: { min: Vec3; max: Vec3 };
  volume: number;
  surfaceArea: number;
  vertexCount: number;
  triangleCount: number;
}

export interface StudioSnapshot {
  models: ModelSummary[];
  activeModel: CadModel | null;
  mesh: RenderMesh | null;
}

export type GenerateTemplate =
  | "bracket"
  | "pipe"
  | "gear"
  | "enclosure"
  | "bolt";
