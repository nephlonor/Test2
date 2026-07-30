#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { MockBackend } from "../backends/mock.ts";
import { RelayBackend } from "../backends/relay.ts";
import { WdaBackend } from "../backends/wda.ts";
import type { DeviceBackend } from "../backends/types.ts";
import type { DeviceCommand } from "../protocol.ts";

/**
 * Operator CLI. Everything here is reachable through MCP too, but when the
 * phone is not responding you want to bisect the chain without a model in the
 * loop: `doctor` tells you which hop is broken.
 */
const USAGE = `iphone-control

  token                       Generate a pairing token
  doctor                      Check the path to the device end to end
  info                        Print device name, iOS version, screen size
  screenshot [file]           Save a PNG (default: screenshot.png)
  describe                    List on-screen elements
  tap <x> <y>                 Tap a point
  swipe <x1> <y1> <x2> <y2>   Drag between two points
  type <text...>              Type into the focused field
  button <home|volumeUp|volumeDown>
  launch <bundleId>           Foreground an app

Backend selected by IPHONE_BACKEND (relay | wda | mock), same as the MCP server.
`;

function backendFromEnv(): DeviceBackend {
  const kind = process.env["IPHONE_BACKEND"] ?? "relay";
  switch (kind) {
    case "mock":
      return new MockBackend();
    case "wda":
      return new WdaBackend({ baseUrl: process.env["WDA_URL"] ?? "http://127.0.0.1:8100" });
    case "relay": {
      const url = process.env["RELAY_URL"];
      const token = process.env["RELAY_TOKEN"];
      if (!url || !token) {
        throw new Error("RELAY_URL and RELAY_TOKEN must be set for the relay backend");
      }
      return new RelayBackend({ url, token, label: "cli", peerTimeoutMs: 15_000 });
    }
    default:
      throw new Error(`unknown IPHONE_BACKEND "${kind}" (expected relay, wda, or mock)`);
  }
}

/** Walks the chain hop by hop so a failure names the layer that broke. */
async function doctor(): Promise<number> {
  const kind = process.env["IPHONE_BACKEND"] ?? "relay";
  console.log(`backend: ${kind}`);

  if (kind === "relay") {
    const url = process.env["RELAY_URL"];
    if (!url) {
      console.error("FAIL  RELAY_URL is not set");
      return 1;
    }
    // The relay serves /healthz on the same port as the WebSocket upgrade.
    const health = url.replace(/^ws/, "http").replace(/\/+$/, "") + "/healthz";
    try {
      const response = await fetch(health, { signal: AbortSignal.timeout(10_000) });
      console.log(`  ok  relay reachable (${health}, HTTP ${response.status})`);
    } catch (error) {
      console.error(`FAIL  relay unreachable at ${health}: ${(error as Error).message}`);
      return 1;
    }
    if (!process.env["RELAY_TOKEN"]) {
      console.error("FAIL  RELAY_TOKEN is not set");
      return 1;
    }
  }

  const backend = backendFromEnv();
  try {
    const info = await backend.execute({ kind: "deviceInfo" });
    if (info.kind !== "deviceInfo") throw new Error(`unexpected result "${info.kind}"`);
    console.log(`  ok  device responded: ${info.name}, iOS ${info.iosVersion}`);
    console.log(`  ok  screen ${info.screen.width}x${info.screen.height} pt`);

    const screen = await backend.execute({ kind: "describeScreen" });
    if (screen.kind === "screen") {
      console.log(`  ok  accessibility tree readable (${screen.elements.length} elements)`);
    }
    console.log("\nAll checks passed.");
    return 0;
  } catch (error) {
    console.error(`FAIL  ${(error as Error).message}`);
    return 1;
  } finally {
    await backend.close();
  }
}

function commandFrom(argv: string[]): DeviceCommand {
  const [name, ...rest] = argv;
  const num = (raw: string | undefined, label: string): number => {
    const value = Number(raw);
    if (!Number.isFinite(value)) throw new Error(`${label} must be a number, got "${raw}"`);
    return value;
  };

  switch (name) {
    case "info":
      return { kind: "deviceInfo" };
    case "screenshot":
      return { kind: "screenshot" };
    case "describe":
      return { kind: "describeScreen" };
    case "tap":
      return { kind: "tap", at: { x: num(rest[0], "x"), y: num(rest[1], "y") } };
    case "swipe":
      return {
        kind: "swipe",
        from: { x: num(rest[0], "x1"), y: num(rest[1], "y1") },
        to: { x: num(rest[2], "x2"), y: num(rest[3], "y2") },
        durationSec: 0.25,
      };
    case "type": {
      const text = rest.join(" ");
      if (!text) throw new Error("type needs some text");
      return { kind: "type", text };
    }
    case "button": {
      const button = rest[0];
      if (button !== "home" && button !== "volumeUp" && button !== "volumeDown") {
        throw new Error(`unknown button "${button ?? ""}"`);
      }
      return { kind: "pressButton", button };
    }
    case "launch": {
      const bundleId = rest[0];
      if (!bundleId) throw new Error("launch needs a bundle id");
      return { kind: "launchApp", bundleId };
    }
    default:
      throw new Error(`unknown command "${name ?? ""}"`);
  }
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const name = argv[0];

  if (!name || name === "help" || name === "--help" || name === "-h") {
    console.log(USAGE);
    return name ? 0 : 1;
  }

  if (name === "token") {
    console.log(randomBytes(24).toString("hex"));
    return 0;
  }

  if (name === "doctor") return doctor();

  const command = commandFrom(argv);
  const backend = backendFromEnv();
  try {
    const result = await backend.execute(command);
    switch (result.kind) {
      case "screenshot": {
        const file = argv[1] ?? "screenshot.png";
        const { writeFile } = await import("node:fs/promises");
        await writeFile(file, Buffer.from(result.pngBase64, "base64"));
        console.log(`wrote ${file}`);
        break;
      }
      case "screen":
        if (result.activeApp) console.log(`foreground: ${result.activeApp}\n`);
        for (const el of result.elements) {
          const [x, y, w, h] = el.rect;
          const label = el.label ?? el.value ?? "";
          console.log(
            `${el.type.padEnd(16)} ${label.slice(0, 40).padEnd(40)} ` +
              `center=(${Math.round(x + w / 2)}, ${Math.round(y + h / 2)})` +
              (el.enabled ? "" : " [disabled]"),
          );
        }
        break;
      case "deviceInfo":
        console.log(`${result.name} — iOS ${result.iosVersion}`);
        console.log(`screen ${result.screen.width}x${result.screen.height} pt`);
        break;
      case "ok":
        console.log("ok");
        break;
    }
    return 0;
  } finally {
    await backend.close();
  }
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
