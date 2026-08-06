import { App } from "@modelcontextprotocol/ext-apps";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

interface ModelSummary {
  id: string;
  name: string;
  color: string;
  revision: number;
  updatedAt: string;
  kind: string;
}

interface CadModel extends ModelSummary {
  shape: Record<string, unknown>;
  createdAt: string;
}

interface RenderMesh {
  positions: number[];
  triangles: number[];
  bounds: { min: [number, number, number]; max: [number, number, number] };
  volume: number;
  surfaceArea: number;
  vertexCount: number;
  triangleCount: number;
}

interface StudioPayload {
  models?: ModelSummary[];
  activeModel?: CadModel | null;
  mesh?: RenderMesh | null;
  data?: string;
  filename?: string;
  format?: string;
}

const byId = <T extends HTMLElement>(id: string) =>
  document.getElementById(id) as T;

const canvas = byId<HTMLCanvasElement>("viewport");
const modelList = byId<HTMLDivElement>("model-list");
const modelCount = byId<HTMLSpanElement>("model-count");
const modelKind = byId<HTMLSpanElement>("model-kind");
const modelName = byId<HTMLInputElement>("model-name");
const modelColor = byId<HTMLInputElement>("model-color");
const modelColorText = byId<HTMLInputElement>("model-color-text");
const shapeJson = byId<HTMLTextAreaElement>("shape-json");
const statusDot = byId<HTMLSpanElement>("status-dot");
const statusText = byId<HTMLSpanElement>("status-text");
const meshStats = byId<HTMLSpanElement>("mesh-stats");
const modelVolume = byId<HTMLSpanElement>("model-volume");
const emptyState = byId<HTMLDivElement>("empty-state");
const toastElement = byId<HTMLDivElement>("toast");

let models: ModelSummary[] = [];
let activeModel: CadModel | null = null;
let activeMesh: RenderMesh | null = null;
let shapeDirty = false;
let busyCount = 0;
let toastTimer = 0;
let connected = false;

const scene = new THREE.Scene();
scene.background = new THREE.Color("#0c0f14");
scene.fog = new THREE.FogExp2("#0c0f14", 0.0025);

const camera = new THREE.PerspectiveCamera(42, 1, 0.05, 100_000);
camera.position.set(72, -92, 68);
camera.up.set(0, 0, 1);

const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: true,
  alpha: false,
  powerPreference: "high-performance",
});
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.08;

const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.07;
controls.screenSpacePanning = true;

scene.add(new THREE.HemisphereLight("#cfe8ff", "#152031", 2.25));
const keyLight = new THREE.DirectionalLight("#ffffff", 3.2);
keyLight.position.set(50, -70, 100);
scene.add(keyLight);
const rimLight = new THREE.DirectionalLight("#7dd3fc", 1.5);
rimLight.position.set(-80, 25, 35);
scene.add(rimLight);

const grid = new THREE.GridHelper(600, 60, "#314052", "#1e2835");
grid.rotation.x = Math.PI / 2;
grid.position.z = -0.02;
scene.add(grid);
const axes = new THREE.AxesHelper(35);
scene.add(axes);

let solidObject: THREE.Mesh | null = null;
let edgeObject: THREE.LineSegments | null = null;
let wireframe = false;

function disposeObject(): void {
  if (solidObject) {
    scene.remove(solidObject);
    solidObject.geometry.dispose();
    (solidObject.material as THREE.Material).dispose();
    solidObject = null;
  }
  if (edgeObject) {
    scene.remove(edgeObject);
    edgeObject.geometry.dispose();
    (edgeObject.material as THREE.Material).dispose();
    edgeObject = null;
  }
}

function showMesh(mesh: RenderMesh | null, fit = false): void {
  disposeObject();
  activeMesh = mesh;
  emptyState.classList.toggle("visible", !mesh);
  if (!mesh || !activeModel) {
    meshStats.textContent = "—";
    modelVolume.textContent = "—";
    return;
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(mesh.positions, 3),
  );
  geometry.setIndex(mesh.triangles);
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();

  const material = new THREE.MeshStandardMaterial({
    color: new THREE.Color(activeModel.color),
    roughness: 0.48,
    metalness: 0.08,
    side: THREE.DoubleSide,
    wireframe,
  });
  solidObject = new THREE.Mesh(geometry, material);
  scene.add(solidObject);

  const edgesGeometry = new THREE.EdgesGeometry(geometry, 22);
  const edgesMaterial = new THREE.LineBasicMaterial({
    color: "#07100e",
    transparent: true,
    opacity: wireframe ? 0 : 0.3,
  });
  edgeObject = new THREE.LineSegments(edgesGeometry, edgesMaterial);
  scene.add(edgeObject);

  meshStats.textContent = `${mesh.vertexCount.toLocaleString()} vertices · ${mesh.triangleCount.toLocaleString()} triangles`;
  modelVolume.textContent = `${mesh.volume.toLocaleString(undefined, { maximumFractionDigits: 2 })} mm³`;
  if (fit) fitView();
}

function fitView(): void {
  if (!solidObject) return;
  const box = new THREE.Box3().setFromObject(solidObject);
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  const distance = Math.max(
    (size.length() / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)))) * 1.18,
    4,
  );
  const direction = camera.position
    .clone()
    .sub(controls.target)
    .normalize();
  controls.target.copy(center);
  camera.position.copy(center).add(direction.multiplyScalar(distance));
  camera.near = Math.max(distance / 1000, 0.01);
  camera.far = distance * 100;
  camera.updateProjectionMatrix();
  controls.update();
}

function resize(): void {
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  if (!width || !height) return;
  renderer.setSize(width, height, false);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(canvas.parentElement!);

function animate(): void {
  controls.update();
  renderer.render(scene, camera);
  requestAnimationFrame(animate);
}
resize();
animate();

function setStatus(message: string, state: "connected" | "error" | "busy" = "connected") {
  statusText.textContent = message;
  statusDot.className = `status-dot ${state === "busy" ? "" : state}`;
}

function toast(message: string, error = false): void {
  window.clearTimeout(toastTimer);
  toastElement.textContent = message;
  toastElement.className = `toast visible${error ? " error" : ""}`;
  toastTimer = window.setTimeout(() => {
    toastElement.className = "toast";
  }, 2600);
}

function renderModelList(): void {
  modelCount.textContent = String(models.length);
  modelList.replaceChildren();
  for (const model of models) {
    const row = document.createElement("button");
    row.className = `model-row${model.id === activeModel?.id ? " active" : ""}`;
    row.innerHTML = `<span class="swatch"></span><span class="model-copy"><strong></strong><small></small></span><span class="revision"></span>`;
    (row.querySelector(".swatch") as HTMLElement).style.background = model.color;
    (row.querySelector("strong") as HTMLElement).textContent = model.name;
    (row.querySelector("small") as HTMLElement).textContent = model.kind;
    (row.querySelector(".revision") as HTMLElement).textContent = `r${model.revision}`;
    row.addEventListener("click", () => void loadModel(model.id, true));
    modelList.append(row);
  }
}

function renderInspector(force = false): void {
  const disabled = !activeModel;
  modelName.disabled = disabled;
  modelColor.disabled = disabled;
  modelColorText.disabled = disabled;
  shapeJson.disabled = disabled;
  modelKind.textContent = activeModel?.shape.kind as string ?? "—";
  if (!activeModel) {
    modelName.value = "";
    shapeJson.value = "";
    return;
  }
  modelName.value = activeModel.name;
  modelColor.value = activeModel.color;
  modelColorText.value = activeModel.color;
  if (!shapeDirty || force) {
    shapeJson.value = JSON.stringify(activeModel.shape, null, 2);
    shapeDirty = false;
  }
}

function applyPayload(payload: StudioPayload | undefined, fit = false): void {
  if (!payload || typeof payload !== "object") return;
  if (Array.isArray(payload.models)) models = payload.models;
  if ("activeModel" in payload) {
    activeModel = payload.activeModel ?? null;
    shapeDirty = false;
  }
  renderModelList();
  renderInspector(true);
  if ("mesh" in payload) showMesh(payload.mesh ?? null, fit);
}

function resultPayload(result: unknown): StudioPayload | undefined {
  if (!result || typeof result !== "object") return undefined;
  return (result as { structuredContent?: StudioPayload }).structuredContent;
}

const app = new App(
  { name: "mcp-cad-studio-view", version: "0.2.1" },
  { availableDisplayModes: ["inline", "pip", "fullscreen"] },
  { autoResize: false },
);

app.ontoolresult = (params) => {
  applyPayload(resultPayload(params), !activeModel);
};

app.onhostcontextchanged = (context) => {
  if (context.theme === "light") document.documentElement.style.colorScheme = "dark";
};

async function callTool(name: string, args: Record<string, unknown> = {}) {
  busyCount += 1;
  document.querySelectorAll<HTMLButtonElement>("button").forEach((button) => {
    button.disabled = true;
  });
  setStatus(`${name.replaceAll("_", " ")}…`, "busy");
  try {
    const result = await app.callServerTool({ name, arguments: args });
    if (result.isError) {
      const message = result.content
        .filter((item) => item.type === "text")
        .map((item) => item.text)
        .join("\n");
      throw new Error(message || `${name} failed`);
    }
    applyPayload(resultPayload(result));
    setStatus("Synchronized with MCP host", "connected");
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setStatus(message, "error");
    toast(message, true);
    throw error;
  } finally {
    busyCount -= 1;
    document.querySelectorAll<HTMLButtonElement>("button").forEach((button) => {
      button.disabled = false;
    });
  }
}

async function loadModel(id: string, fit = false): Promise<void> {
  try {
    const result = await callTool("load_model", { modelId: id });
    applyPayload(resultPayload(result), fit);
  } catch {
    // callTool reports the error.
  }
}

const primitiveDefaults: Record<string, Record<string, unknown>> = {
  box: { kind: "box", size: [40, 30, 20], center: true },
  sphere: { kind: "sphere", radius: 18, segments: 48 },
  cylinder: { kind: "cylinder", height: 35, radius: 14, segments: 48, center: true },
  cone: { kind: "cone", height: 35, radiusBottom: 16, radiusTop: 5, segments: 48, center: true },
};

byId<HTMLButtonElement>("new-model").addEventListener("click", async () => {
  const kind = byId<HTMLSelectElement>("new-kind").value;
  const label = kind[0]!.toUpperCase() + kind.slice(1);
  try {
    const result = await callTool("create_model", {
      name: `${label} ${models.length + 1}`,
      color: "#6ee7b7",
      shape: primitiveDefaults[kind],
    });
    applyPayload(resultPayload(result), true);
    toast(`${label} created`);
  } catch { /* reported */ }
});

byId<HTMLButtonElement>("generate-model").addEventListener("click", async () => {
  const template = byId<HTMLSelectElement>("preset-kind").value;
  const label = template[0]!.toUpperCase() + template.slice(1);
  try {
    const result = await callTool("generate_model", {
      name: `${label} ${models.length + 1}`,
      template,
      color: "#60a5fa",
    });
    applyPayload(resultPayload(result), true);
    toast(`${label} generated`);
  } catch { /* reported */ }
});

modelColor.addEventListener("input", () => {
  modelColorText.value = modelColor.value;
  if (solidObject) (solidObject.material as THREE.MeshStandardMaterial).color.set(modelColor.value);
});
modelColorText.addEventListener("change", () => {
  if (/^#[0-9a-f]{6}$/i.test(modelColorText.value)) {
    modelColor.value = modelColorText.value;
    if (solidObject) (solidObject.material as THREE.MeshStandardMaterial).color.set(modelColor.value);
  }
});
shapeJson.addEventListener("input", () => { shapeDirty = true; });

byId<HTMLButtonElement>("save-model").addEventListener("click", async () => {
  if (!activeModel) return;
  try {
    const shape = JSON.parse(shapeJson.value) as Record<string, unknown>;
    const result = await callTool("update_model", {
      modelId: activeModel.id,
      name: modelName.value,
      color: modelColorText.value,
      shape,
      expectedRevision: activeModel.revision,
    });
    applyPayload(resultPayload(result));
    toast("Model saved");
  } catch (error) {
    if (error instanceof SyntaxError) toast(`Invalid JSON: ${error.message}`, true);
  }
});

function transformValues(kind: string): [number, number, number] {
  const values = [...document.querySelectorAll<HTMLInputElement>(`.transform[data-transform="${kind}"]`)];
  return values.map((input) => Number(input.value)) as [number, number, number];
}

byId<HTMLButtonElement>("apply-transform").addEventListener("click", async () => {
  if (!activeModel) return;
  try {
    const result = await callTool("transform_model", {
      modelId: activeModel.id,
      translation: transformValues("translation"),
      rotation: transformValues("rotation"),
      scale: transformValues("scale"),
      expectedRevision: activeModel.revision,
    });
    applyPayload(resultPayload(result), true);
    document.querySelectorAll<HTMLInputElement>('.transform[data-transform="translation"], .transform[data-transform="rotation"]').forEach((input) => { input.value = "0"; });
    document.querySelectorAll<HTMLInputElement>('.transform[data-transform="scale"]').forEach((input) => { input.value = "1"; });
    toast("Transform applied");
  } catch { /* reported */ }
});

byId<HTMLButtonElement>("duplicate-model").addEventListener("click", async () => {
  if (!activeModel) return;
  try {
    const result = await callTool("duplicate_model", { modelId: activeModel.id });
    applyPayload(resultPayload(result), true);
    toast("Model duplicated");
  } catch { /* reported */ }
});

byId<HTMLButtonElement>("delete-model").addEventListener("click", async () => {
  if (!activeModel || !window.confirm(`Delete “${activeModel.name}”?`)) return;
  const deletedName = activeModel.name;
  try {
    const result = await callTool("delete_model", {
      modelId: activeModel.id,
      expectedRevision: activeModel.revision,
    });
    applyPayload(resultPayload(result));
    if (activeModel) fitView();
    else if (models[0]) await loadModel(models[0].id, true);
    else { showMesh(null); renderInspector(true); }
    toast(`${deletedName} deleted`);
  } catch { /* reported */ }
});

async function exportModel(format: "stl" | "obj") {
  if (!activeModel) return;
  try {
    const result = await callTool("export_model", {
      modelId: activeModel.id,
      format,
    });
    const payload = resultPayload(result);
    if (!payload?.data || !payload.filename) throw new Error("Export returned no file data");
    const blob = new Blob([payload.data], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = payload.filename;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast(`${payload.filename} exported`);
  } catch { /* reported */ }
}
byId<HTMLButtonElement>("export-stl").addEventListener("click", () => void exportModel("stl"));
byId<HTMLButtonElement>("export-obj").addEventListener("click", () => void exportModel("obj"));

const fileInput = byId<HTMLInputElement>("file-input");
byId<HTMLButtonElement>("import-button").addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", async () => {
  const file = fileInput.files?.[0];
  if (!file) return;
  const format = file.name.toLowerCase().endsWith(".obj") ? "obj" : "stl";
  try {
    const data = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(reader.error);
      reader.onload = () => resolve(String(reader.result).split(",", 2)[1] ?? "");
      reader.readAsDataURL(file);
    });
    const result = await callTool("import_model", {
      name: file.name.replace(/\.[^.]+$/, ""),
      format,
      data,
      encoding: "base64",
      color: "#f59e0b",
    });
    applyPayload(resultPayload(result), true);
    toast(`${file.name} imported`);
  } catch { /* reported */ }
  fileInput.value = "";
});

byId<HTMLButtonElement>("fit-view").addEventListener("click", fitView);
byId<HTMLButtonElement>("wireframe").addEventListener("click", () => {
  wireframe = !wireframe;
  if (solidObject) (solidObject.material as THREE.MeshStandardMaterial).wireframe = wireframe;
  if (edgeObject) (edgeObject.material as THREE.LineBasicMaterial).opacity = wireframe ? 0 : 0.3;
});
byId<HTMLButtonElement>("toggle-inspector").addEventListener("click", () => {
  byId<HTMLElement>("inspector").classList.toggle("open");
});

async function poll(): Promise<void> {
  if (!connected || busyCount > 0) return;
  try {
    const result = await app.callServerTool({ name: "list_models", arguments: {} });
    const payload = resultPayload(result);
    if (!payload?.models) return;
    const currentSummary = payload.models.find((model) => model.id === activeModel?.id);
    models = payload.models;
    renderModelList();
    if (activeModel && currentSummary && currentSummary.revision !== activeModel.revision) {
      await loadModel(activeModel.id);
      toast("Model updated by an MCP tool");
    } else if (activeModel && !currentSummary) {
      activeModel = null;
      showMesh(null);
      renderInspector(true);
    }
  } catch {
    // Keep the current canvas usable during transient host disconnects.
  }
}

async function connect(): Promise<void> {
  try {
    await app.connect();
    connected = true;
    setStatus("Connected to MCP host", "connected");
    window.setInterval(() => void poll(), 2200);
    window.setTimeout(async () => {
      if (!activeModel) {
        try {
          const result = await app.callServerTool({ name: "list_models", arguments: {} });
          const payload = resultPayload(result);
          if (payload?.models) {
            models = payload.models;
            renderModelList();
            if (models[0]) await loadModel(models[0].id, true);
          }
        } catch { /* initial studio result may still arrive */ }
      }
    }, 250);
  } catch (error) {
    setStatus(
      `MCP Apps bridge unavailable: ${error instanceof Error ? error.message : String(error)}`,
      "error",
    );
  }
}

void connect();
