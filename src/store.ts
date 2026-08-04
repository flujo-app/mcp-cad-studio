import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { CadModel, ModelSummary, ShapeNode } from "./types.js";

interface StoreDocument {
  version: 1;
  models: CadModel[];
}

export interface CreateModelInput {
  name: string;
  color: string;
  shape: ShapeNode;
}

export interface UpdateModelInput {
  name?: string;
  color?: string;
  shape?: ShapeNode;
  expectedRevision?: number;
}

export class CadStore {
  readonly dataFile: string | null;
  private models = new Map<string, CadModel>();
  private loaded = false;
  private writeChain = Promise.resolve();

  constructor(dataFile: string | null) {
    this.dataFile = dataFile;
  }

  async ready(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    if (!this.dataFile) return;
    try {
      const document = JSON.parse(await readFile(this.dataFile, "utf8")) as StoreDocument;
      if (document.version !== 1 || !Array.isArray(document.models)) {
        throw new Error("Unsupported CAD Studio data format");
      }
      for (const model of document.models) this.models.set(model.id, model);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") throw error;
    }
  }

  list(): ModelSummary[] {
    return [...this.models.values()]
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .map((model) => ({
        id: model.id,
        name: model.name,
        color: model.color,
        revision: model.revision,
        updatedAt: model.updatedAt,
        kind: model.shape.kind,
      }));
  }

  get(id: string): CadModel {
    const model = this.models.get(id);
    if (!model) throw new Error(`CAD model not found: ${id}`);
    return structuredClone(model);
  }

  async create(input: CreateModelInput): Promise<CadModel> {
    const timestamp = new Date().toISOString();
    const model: CadModel = {
      id: randomUUID(),
      name: input.name,
      color: input.color,
      shape: structuredClone(input.shape),
      revision: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.models.set(model.id, model);
    await this.persist();
    return structuredClone(model);
  }

  async update(id: string, input: UpdateModelInput): Promise<CadModel> {
    const current = this.models.get(id);
    if (!current) throw new Error(`CAD model not found: ${id}`);
    if (
      input.expectedRevision !== undefined &&
      input.expectedRevision !== current.revision
    ) {
      throw new Error(
        `Revision conflict: expected ${input.expectedRevision}, current revision is ${current.revision}`,
      );
    }
    const model: CadModel = {
      ...current,
      name: input.name ?? current.name,
      color: input.color ?? current.color,
      shape: input.shape ? structuredClone(input.shape) : current.shape,
      revision: current.revision + 1,
      updatedAt: new Date().toISOString(),
    };
    this.models.set(id, model);
    await this.persist();
    return structuredClone(model);
  }

  async duplicate(id: string, name?: string): Promise<CadModel> {
    const source = this.get(id);
    return this.create({
      name: name ?? `${source.name} copy`,
      color: source.color,
      shape: source.shape,
    });
  }

  async delete(id: string): Promise<CadModel> {
    const model = this.get(id);
    this.models.delete(id);
    await this.persist();
    return model;
  }

  private async persist(): Promise<void> {
    if (!this.dataFile) return;
    const payload = `${JSON.stringify(
      { version: 1, models: [...this.models.values()] } satisfies StoreDocument,
      null,
      2,
    )}\n`;
    const dataFile = this.dataFile;
    this.writeChain = this.writeChain.then(async () => {
      await mkdir(dirname(dataFile), { recursive: true });
      const temporary = `${dataFile}.${process.pid}.tmp`;
      await writeFile(temporary, payload, "utf8");
      await rename(temporary, dataFile);
    });
    await this.writeChain;
  }
}
