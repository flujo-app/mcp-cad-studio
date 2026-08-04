import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CadStore } from "../src/store.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe("CadStore", () => {
  it("persists models and protects revisions", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cad-studio-test-"));
    directories.push(directory);
    const dataFile = join(directory, "models.json");
    const store = new CadStore(dataFile);
    await store.ready();
    const model = await store.create({
      name: "Fixture",
      color: "#ffffff",
      shape: { kind: "sphere", radius: 5 },
    });
    const updated = await store.update(model.id, {
      name: "Fixture 2",
      expectedRevision: 1,
    });
    expect(updated.revision).toBe(2);
    await expect(
      store.update(model.id, { name: "stale", expectedRevision: 1 }),
    ).rejects.toThrow("Revision conflict");

    const restored = new CadStore(dataFile);
    await restored.ready();
    expect(restored.get(model.id).name).toBe("Fixture 2");

    await expect(restored.delete(model.id, 1)).rejects.toThrow("Revision conflict");
    await restored.delete(model.id, 2);
    expect(restored.list()).toEqual([]);
    const afterDelete = new CadStore(dataFile);
    await afterDelete.ready();
    expect(afterDelete.list()).toEqual([]);
  });
});
