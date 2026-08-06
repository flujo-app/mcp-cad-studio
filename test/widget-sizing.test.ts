import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Regression tests for the widget rendering as a ~200px sliver in MCP App hosts.
//
// Hosts embed an inline app in a short placeholder iframe (FLUJO uses 200px) and
// enlarge it only when the app sends `ui/notifications/size-changed`. The ext-apps
// SDK sends those for us, but only when `autoResize` is enabled, and it derives the
// height from the document element - so the document must be sized by its content
// rather than pinned to the frame it is currently in.

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const widgetSource = readFileSync(join(root, "src", "widget", "app.ts"), "utf8");
const widgetHtml = readFileSync(join(root, "src", "widget", "index.html"), "utf8");

function rule(css: string, selector: string): string {
  const body = css.match(new RegExp(`${selector}\\s*\\{([^}]*)\\}`))?.[1];
  if (body === undefined) throw new Error(`No CSS rule found for "${selector}"`);
  return body;
}

describe("widget host sizing", () => {
  it("leaves the SDK's auto-resize enabled", () => {
    // `connect()` installs the size reporter only when this option is truthy.
    expect(widgetSource).not.toMatch(/autoResize:\s*false/);
    expect(widgetSource).toMatch(/autoResize:\s*true/);
  });

  it("lets the document be sized by its content, not by the host frame", () => {
    const htmlBody = rule(widgetHtml, "html, body");
    expect(htmlBody).toContain("min-height: 100%");
    // `height: 100%` would report the host's placeholder height back to the host.
    expect(htmlBody).not.toMatch(/[^-]height:\s*100%/);
  });

  it("asks for a workable height even inside a short host frame", () => {
    expect(rule(widgetHtml, "\\.shell")).toMatch(/min-height:\s*560px/);
  });

  it("ships those rules and that flag in the built widget", () => {
    const built = join(root, "dist", "widget.html");
    if (!existsSync(built)) return; // `npm run check` builds before it tests
    const html = readFileSync(built, "utf8");
    expect(html).not.toMatch(/autoResize:\s*(!1|false)/);
    expect(rule(html, "html, body")).toContain("min-height: 100%");
  });
});
