import { mkdir, readFile, writeFile } from "node:fs/promises";
import { build } from "esbuild";

const result = await build({
  entryPoints: ["src/widget/app.ts"],
  bundle: true,
  minify: true,
  format: "iife",
  platform: "browser",
  target: ["es2022"],
  write: false,
  legalComments: "none",
});

const bundle = result.outputFiles?.[0]?.text;
if (!bundle) throw new Error("Widget bundle was not generated");

const template = await readFile("src/widget/index.html", "utf8");
const safeBundle = bundle.replace(/<\/script/gi, "<\\/script");
const html = template.replace(
  "<!-- SCRIPT -->",
  () => `<script>${safeBundle}</script>`,
);
await mkdir("dist", { recursive: true });
await writeFile("dist/widget.html", html, "utf8");
