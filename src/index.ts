export { createCadStudioServer, STUDIO_RESOURCE_URI } from "./server.js";
export { startNetworkServer } from "./http.js";
export { CadStore } from "./store.js";
export { generatePreset } from "./presets.js";
export { importModel } from "./importers.js";
export { renderShape, exportObj, exportStl } from "./geometry.js";
export {
  assertValidShape,
  validateShape,
  ShapeValidationError,
} from "./validation.js";
export type {
  ShapeIssue,
  ShapeIssueSeverity,
  ShapeValidationResult,
} from "./validation.js";
export type {
  CadModel,
  GenerateTemplate,
  ModelSummary,
  RenderMesh,
  ShapeNode,
  StudioSnapshot,
  Transform,
  Vec2,
  Vec3,
} from "./types.js";
