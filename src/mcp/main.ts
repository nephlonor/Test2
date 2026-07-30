#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { RelayBackend } from "../backends/relay.ts";
import { MockBackend } from "../backends/mock.ts";
import { WdaBackend } from "../backends/wda.ts";
import type { DeviceBackend } from "../backends/types.ts";
import { createMcpServer } from "./server.ts";

/**
 * Entry point for the MCP server. The backend is chosen by environment so the
 * same binary works against a mock, a phone on the LAN, or a phone across a
 * relay.
 *
 *   IPHONE_BACKEND=relay  RELAY_URL=... RELAY_TOKEN=...   (remote sandbox)
 *   IPHONE_BACKEND=wda    WDA_URL=http://127.0.0.1:8100   (same network)
 *   IPHONE_BACKEND=mock                                   (no hardware)
 */
function selectBackend(): DeviceBackend {
  const kind = process.env["IPHONE_BACKEND"] ?? "relay";

  switch (kind) {
    case "mock":
      return new MockBackend();

    case "wda": {
      const baseUrl = process.env["WDA_URL"] ?? "http://127.0.0.1:8100";
      return new WdaBackend({ baseUrl });
    }

    case "relay": {
      const url = required("RELAY_URL");
      const token = required("RELAY_TOKEN");
      return new RelayBackend({ url, token, label: "claude-session" });
    }

    default:
      throw new Error(`unknown IPHONE_BACKEND "${kind}" (expected relay, wda, or mock)`);
  }
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} must be set`);
  return value;
}

async function main(): Promise<void> {
  const backend = selectBackend();
  const server = createMcpServer(backend);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stdout is the MCP channel; diagnostics must go to stderr.
  console.error(`[mcp] iphone-control ready (backend: ${backend.name})`);

  const shutdown = async () => {
    await backend.close();
    await server.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

main().catch((error: unknown) => {
  console.error(`[mcp] fatal: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
