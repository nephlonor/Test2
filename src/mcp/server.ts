import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { DeviceBackend } from "../backends/types.ts";
import type { DeviceResult, ScreenElement } from "../protocol.ts";

/**
 * Exposes the phone as MCP tools.
 *
 * Tool descriptions are written for the model, not for humans: they say what
 * the tool does to the device and, where it matters, that coordinates come from
 * `describe_screen` rather than from guessing at a screenshot.
 */
export function createMcpServer(backend: DeviceBackend): McpServer {
  const server = new McpServer({
    name: "iphone-control",
    version: "0.1.0",
  });

  server.registerTool(
    "device_info",
    {
      title: "Get device info",
      description:
        "Return the connected iPhone's name, iOS version, and screen size in points. " +
        "Call this first to learn the coordinate space for tap and swipe.",
      inputSchema: {},
    },
    async () => {
      const result = await backend.execute({ kind: "deviceInfo" });
      expectKind(result, "deviceInfo");
      return text(
        `${result.name} — iOS ${result.iosVersion}, ${result.screen.width}x${result.screen.height} pt`,
      );
    },
  );

  server.registerTool(
    "screenshot",
    {
      title: "Screenshot",
      description:
        "Capture what is currently on the iPhone screen as a PNG image. " +
        "Use this to see the device; use describe_screen to get tappable coordinates.",
      inputSchema: {},
    },
    async () => {
      const result = await backend.execute({ kind: "screenshot" });
      expectKind(result, "screenshot");
      return {
        content: [{ type: "image" as const, data: result.pngBase64, mimeType: "image/png" }],
      };
    },
  );

  server.registerTool(
    "describe_screen",
    {
      title: "Describe screen",
      description:
        "List the visible on-screen elements with their labels and bounding boxes in points. " +
        "This is the reliable way to find where to tap — read coordinates from here rather than " +
        "estimating them from a screenshot.",
      inputSchema: {},
    },
    async () => {
      const result = await backend.execute({ kind: "describeScreen" });
      expectKind(result, "screen");
      if (result.elements.length === 0) {
        return text("No labelled elements are visible on the current screen.");
      }
      const header = result.activeApp ? `Foreground app: ${result.activeApp}\n\n` : "";
      return text(header + result.elements.map(formatElement).join("\n"));
    },
  );

  server.registerTool(
    "tap",
    {
      title: "Tap",
      description:
        "Tap the screen at a point, in points, with (0,0) at the top-left. " +
        "Prefer the center of an element returned by describe_screen.",
      inputSchema: {
        x: z.number().describe("Horizontal position in points from the left edge."),
        y: z.number().describe("Vertical position in points from the top edge."),
      },
    },
    async ({ x, y }) => {
      await backend.execute({ kind: "tap", at: { x, y } });
      return text(`Tapped (${x}, ${y}).`);
    },
  );

  server.registerTool(
    "swipe",
    {
      title: "Swipe",
      description:
        "Drag from one point to another. Use this to scroll (swipe up to scroll down the page), " +
        "dismiss sheets, or open Control Center.",
      inputSchema: {
        fromX: z.number(),
        fromY: z.number(),
        toX: z.number(),
        toY: z.number(),
        durationSec: z
          .number()
          .positive()
          .max(10)
          .optional()
          .describe("Gesture duration in seconds. Defaults to 0.25; use ~1.0 for a slow drag."),
      },
    },
    async ({ fromX, fromY, toX, toY, durationSec }) => {
      await backend.execute({
        kind: "swipe",
        from: { x: fromX, y: fromY },
        to: { x: toX, y: toY },
        durationSec: durationSec ?? 0.25,
      });
      return text(`Swiped (${fromX}, ${fromY}) -> (${toX}, ${toY}).`);
    },
  );

  server.registerTool(
    "type_text",
    {
      title: "Type text",
      description:
        "Type text into the currently focused field. Tap the field first — this does not focus it.",
      inputSchema: {
        text: z.string().max(4096).describe("The literal text to type."),
      },
    },
    async ({ text: value }) => {
      await backend.execute({ kind: "type", text: value });
      return text(`Typed ${value.length} character${value.length === 1 ? "" : "s"}.`);
    },
  );

  server.registerTool(
    "press_button",
    {
      title: "Press hardware button",
      description: "Press a hardware button. 'home' returns to the home screen.",
      inputSchema: {
        button: z.enum(["home", "volumeUp", "volumeDown"]),
      },
    },
    async ({ button }) => {
      await backend.execute({ kind: "pressButton", button });
      return text(`Pressed ${button}.`);
    },
  );

  server.registerTool(
    "launch_app",
    {
      title: "Launch app",
      description:
        "Bring an app to the foreground by bundle id, e.g. com.apple.Preferences for Settings " +
        "or com.apple.mobilesafari for Safari.",
      inputSchema: {
        bundleId: z.string().min(1).describe("The app's bundle identifier."),
      },
    },
    async ({ bundleId }) => {
      await backend.execute({ kind: "launchApp", bundleId });
      return text(`Launched ${bundleId}.`);
    },
  );

  return server;
}

function formatElement(el: ScreenElement): string {
  const [x, y, w, h] = el.rect;
  const center = `center=(${Math.round(x + w / 2)}, ${Math.round(y + h / 2)})`;
  const parts = [el.type];
  if (el.label) parts.push(`"${el.label}"`);
  if (el.value) parts.push(`value="${el.value}"`);
  if (!el.enabled) parts.push("(disabled)");
  return `- ${parts.join(" ")} ${center} rect=[${x}, ${y}, ${w}, ${h}]`;
}

function text(message: string) {
  return { content: [{ type: "text" as const, text: message }] };
}

/** Narrows a result, guarding against a backend returning the wrong variant. */
function expectKind<K extends DeviceResult["kind"]>(
  result: DeviceResult,
  kind: K,
): asserts result is Extract<DeviceResult, { kind: K }> {
  if (result.kind !== kind) {
    throw new Error(`expected a "${kind}" result from the device but got "${result.kind}"`);
  }
}
