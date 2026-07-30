#!/usr/bin/env node
import { RelayServer } from "./server.ts";

/**
 * Standalone relay process.
 *
 *   PORT=8787 RELAY_TOKENS=secret-one,secret-two npm run relay
 *
 * Deploy this somewhere both the sandbox and the phone can reach over TLS.
 * Terminate HTTPS in front of it; the relay itself speaks plain WebSocket.
 */
const port = Number(process.env["PORT"] ?? 8787);
const host = process.env["HOST"] ?? "0.0.0.0";
const tokens = (process.env["RELAY_TOKENS"] ?? "")
  .split(",")
  .map((t) => t.trim())
  .filter((t) => t.length > 0);

if (tokens.length === 0) {
  console.error(
    "[relay] warning: RELAY_TOKENS is unset — any client with a 16+ character token can pair. " +
      "Set RELAY_TOKENS before exposing this to the internet.",
  );
}

const relay = new RelayServer({ port, host, allowedTokens: tokens });

const shutdown = () => {
  void relay.close().then(() => process.exit(0));
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

relay.listen().catch((error: unknown) => {
  console.error(`[relay] fatal: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
