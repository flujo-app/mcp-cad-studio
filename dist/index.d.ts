import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Server } from 'node:http';
import { Server as Server$1 } from 'node:https';

type Vec2 = [number, number];
type Vec3 = [number, number, number];
interface Transform {
    translation?: Vec3;
    rotation?: Vec3;
    scale?: Vec3;
}
interface ShapeBase {
    transform?: Transform;
}
type ShapeNode = (ShapeBase & {
    kind: "box";
    size: Vec3;
    center?: boolean;
}) | (ShapeBase & {
    kind: "sphere";
    radius: number;
    segments?: number;
}) | (ShapeBase & {
    kind: "cylinder";
    height: number;
    radius: number;
    segments?: number;
    center?: boolean;
}) | (ShapeBase & {
    kind: "cone";
    height: number;
    radiusBottom: number;
    radiusTop: number;
    segments?: number;
    center?: boolean;
}) | (ShapeBase & {
    kind: "extrude";
    points: Vec2[];
    height: number;
    twist?: number;
    scaleTop?: Vec2;
    center?: boolean;
}) | (ShapeBase & {
    kind: "mesh";
    vertices: number[];
    triangles: number[];
}) | (ShapeBase & {
    kind: "union" | "difference" | "intersection";
    children: ShapeNode[];
});
interface CadModel {
    id: string;
    name: string;
    color: string;
    shape: ShapeNode;
    revision: number;
    createdAt: string;
    updatedAt: string;
}
interface ModelSummary {
    id: string;
    name: string;
    color: string;
    revision: number;
    updatedAt: string;
    kind: ShapeNode["kind"];
}
interface RenderMesh {
    positions: number[];
    triangles: number[];
    bounds: {
        min: Vec3;
        max: Vec3;
    };
    volume: number;
    surfaceArea: number;
    vertexCount: number;
    triangleCount: number;
}
interface StudioSnapshot {
    models: ModelSummary[];
    activeModel: CadModel | null;
    mesh: RenderMesh | null;
}
type GenerateTemplate = "bracket" | "pipe" | "gear" | "enclosure" | "bolt";

interface CreateModelInput {
    name: string;
    color: string;
    shape: ShapeNode;
}
interface UpdateModelInput {
    name?: string;
    color?: string;
    shape?: ShapeNode;
    expectedRevision?: number;
}
declare class CadStore {
    readonly dataFile: string | null;
    private models;
    private loaded;
    private writeChain;
    constructor(dataFile: string | null);
    ready(): Promise<void>;
    list(): ModelSummary[];
    get(id: string): CadModel;
    create(input: CreateModelInput): Promise<CadModel>;
    update(id: string, input: UpdateModelInput): Promise<CadModel>;
    duplicate(id: string, name?: string): Promise<CadModel>;
    delete(id: string): Promise<CadModel>;
    private persist;
}

declare const STUDIO_RESOURCE_URI = "ui://cad-studio/studio.html";
interface CadStudioServerOptions {
    store: CadStore;
    widgetHtml?: string;
}
declare function createCadStudioServer(options: CadStudioServerOptions): Promise<McpServer>;

interface NetworkServerOptions {
    store: CadStore;
    host: string;
    port: number;
    https: boolean;
    tlsCert?: string;
    tlsKey?: string;
    widgetHtml?: string;
}
interface RunningNetworkServer {
    server: Server | Server$1;
    url: string;
    selfSigned: boolean;
}
declare function startNetworkServer(options: NetworkServerOptions): Promise<RunningNetworkServer>;

interface TemplateParameters {
    width?: number;
    depth?: number;
    height?: number;
    thickness?: number;
    radius?: number;
    holeRadius?: number;
    teeth?: number;
}
declare function generatePreset(template: GenerateTemplate, parameters?: TemplateParameters): ShapeNode;

declare function importModel(format: "stl" | "obj", data: string, encoding: "text" | "base64"): ShapeNode;

declare function renderShape(shape: ShapeNode): Promise<RenderMesh>;
declare function exportObj(shape: ShapeNode, name: string): Promise<string>;
declare function exportStl(shape: ShapeNode, name: string): Promise<string>;

export { type CadModel, CadStore, type GenerateTemplate, type ModelSummary, type RenderMesh, STUDIO_RESOURCE_URI, type ShapeNode, type StudioSnapshot, type Transform, type Vec2, type Vec3, createCadStudioServer, exportObj, exportStl, generatePreset, importModel, renderShape, startNetworkServer };
