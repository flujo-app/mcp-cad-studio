import type { CadModel } from "./types.js";

export type ModelPatchOperation =
  | { op: "add" | "replace"; path: string; value: unknown }
  | { op: "remove"; path: string };

export interface EditableModelDocument {
  name: string;
  color: string;
  shape: CadModel["shape"];
}

const blockedTokens = new Set(["__proto__", "prototype", "constructor"]);

function decodePointer(path: string): string[] {
  if (!path.startsWith("/") || path === "/") {
    throw new Error(
      "Patch path must point inside the editable model, such as /shape/size/0.",
    );
  }
  return path.slice(1).split("/").map((token) => {
    if (/~(?:[^01]|$)/.test(token)) {
      throw new Error(`Patch path contains an invalid JSON Pointer escape: ${path}`);
    }
    const decoded = token.replaceAll("~1", "/").replaceAll("~0", "~");
    if (blockedTokens.has(decoded)) {
      throw new Error(`Patch path contains a forbidden property: ${decoded}`);
    }
    return decoded;
  });
}

function arrayIndex(token: string, length: number, allowEnd: boolean): number {
  if (!/^(0|[1-9]\d*)$/.test(token)) {
    throw new Error(`Expected an array index but received ${JSON.stringify(token)}.`);
  }
  const index = Number(token);
  if (index > length || (!allowEnd && index === length)) {
    throw new Error(`Array index ${index} is outside the current array.`);
  }
  return index;
}

function isContainer(value: unknown): value is Record<string, unknown> | unknown[] {
  return value !== null && typeof value === "object";
}

function parentAt(document: EditableModelDocument, tokens: string[]): {
  parent: Record<string, unknown> | unknown[];
  token: string;
} {
  let current: unknown = document;
  for (const token of tokens.slice(0, -1)) {
    if (!isContainer(current)) {
      throw new Error(`Patch path enters a non-container value at ${JSON.stringify(token)}.`);
    }
    if (Array.isArray(current)) {
      const index = arrayIndex(token, current.length, false);
      current = current[index];
    } else {
      if (!Object.hasOwn(current, token)) {
        throw new Error(`Patch path property does not exist: ${token}`);
      }
      current = current[token];
    }
  }
  if (!isContainer(current)) {
    throw new Error("Patch path parent is not an object or array.");
  }
  return { parent: current, token: tokens.at(-1)! };
}

function applyPatch(document: EditableModelDocument, patch: ModelPatchOperation): void {
  const tokens = decodePointer(patch.path);
  if (!new Set(["name", "color", "shape"]).has(tokens[0]!)) {
    throw new Error("Only /name, /color, and /shape may be patched.");
  }
  const { parent, token } = parentAt(document, tokens);
  if (Array.isArray(parent)) {
    if (patch.op === "add") {
      if (token === "-") {
        parent.push(structuredClone(patch.value));
      } else {
        parent.splice(arrayIndex(token, parent.length, true), 0, structuredClone(patch.value));
      }
    } else {
      const index = arrayIndex(token, parent.length, false);
      if (patch.op === "remove") parent.splice(index, 1);
      else parent[index] = structuredClone(patch.value);
    }
    return;
  }

  if (patch.op !== "add" && !Object.hasOwn(parent, token)) {
    throw new Error(`Patch path property does not exist: ${token}`);
  }
  if (patch.op === "remove") delete parent[token];
  else parent[token] = structuredClone(patch.value);
}

export function applyModelPatches(
  model: CadModel,
  patches: readonly ModelPatchOperation[],
): EditableModelDocument {
  const document: EditableModelDocument = structuredClone({
    name: model.name,
    color: model.color,
    shape: model.shape,
  });
  patches.forEach((patch, index) => {
    try {
      applyPatch(document, patch);
    } catch (error) {
      throw new Error(
        `Patch ${index} (${patch.op} ${patch.path}) failed: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  });
  return document;
}
