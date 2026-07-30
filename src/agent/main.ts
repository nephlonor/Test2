#!/usr/bin/env node
import { MockBackend } from "../backends/mock.ts";
import { WdaBackend } from "../backends/wda.ts";
import type { DeviceBackend } from "../backends/types.ts";
import { PhoneAgent } from "./phone-agent.ts";

/**
 * Phone-side agent.
 *
 *   RELAY_URL=wss://relay.example.com RELAY_TOKEN=... WDA_URL=http://127.0.0.1:8100 npm run agent
 *
 * Run this wherever it can reach WebDriverAgent on the device. It dials out to
 * the relay, so the phone needs no inbound connectivity.
 */
function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`[agent] fatal: ${name} must be set`);
    process.exit(1);
  }
  return value;
}

const url = required("RELAY_URL");
const token = required("RELAY_TOKEN");

const backend: DeviceBackend =
  process.env["IPHONE_BACKEND"] === "mock"
    ? new MockBackend()
    : new WdaBackend({ baseUrl: process.env["WDA_URL"] ?? "http://127.0.0.1:8100" });

const agent = new PhoneAgent({
  url,
  token,
  label: process.env["DEVICE_LABEL"] ?? "iphone",
  backend,
});

const shutdown = () => {
  void agent.close().then(() => process.exit(0));
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

agent.start().catch((error: unknown) => {
  // start() rejects on the first disconnect; the agent retries internally, so
  // this is a log line rather than a fatal error.
  console.error(`[agent] ${error instanceof Error ? error.message : String(error)}`);
});
