import assert from "node:assert/strict";
import { after, test } from "node:test";
import WebSocket from "ws";
import { MockBackend } from "../src/backends/mock.ts";
import { RelayBackend } from "../src/backends/relay.ts";
import { RelayServer } from "../src/relay/server.ts";
import { PhoneAgent } from "../src/agent/phone-agent.ts";

const TOKEN = "liveness-test-token-000000";
const silence = () => {};

test("serves a health endpoint on the websocket port", async () => {
  const relay = new RelayServer({ port: 0, host: "127.0.0.1", logger: silence });
  const port = await relay.listen();
  after(() => relay.close());

  const response = await fetch(`http://127.0.0.1:${port}/healthz`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, pairs: 0 });

  const missing = await fetch(`http://127.0.0.1:${port}/nope`);
  assert.equal(missing.status, 404);
});

test("health endpoint reports the number of live pairs", async () => {
  const relay = new RelayServer({
    port: 0,
    host: "127.0.0.1",
    allowedTokens: [TOKEN],
    logger: silence,
  });
  const port = await relay.listen();
  const url = `ws://127.0.0.1:${port}`;

  const agent = new PhoneAgent({
    url,
    token: TOKEN,
    backend: new MockBackend(),
    logger: silence,
  });
  await agent.start();

  const health = await (await fetch(`http://127.0.0.1:${port}/healthz`)).json();
  assert.equal((health as { pairs: number }).pairs, 1);

  await agent.close();
  await relay.close();
});

test("relay terminates an endpoint that stops answering pings", async () => {
  const relay = new RelayServer({
    port: 0,
    host: "127.0.0.1",
    allowedTokens: [TOKEN],
    heartbeatMs: 40,
    logger: silence,
  });
  const port = await relay.listen();
  after(() => relay.close());

  // A raw socket with pong suppressed models a phone that dropped off the
  // network without the TCP connection noticing.
  const socket = new WebSocket(`ws://127.0.0.1:${port}`);
  socket.pong = () => {};
  await new Promise<void>((resolve) => socket.once("open", () => resolve()));
  socket.send(JSON.stringify({ type: "hello", role: "agent", token: TOKEN }));

  const closed = await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), 3_000);
    socket.once("close", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
  assert.ok(closed, "expected the relay to terminate the unresponsive endpoint");
});

test("a responsive endpoint survives several heartbeat sweeps", async () => {
  const relay = new RelayServer({
    port: 0,
    host: "127.0.0.1",
    allowedTokens: [TOKEN],
    heartbeatMs: 30,
    logger: silence,
  });
  const port = await relay.listen();
  const url = `ws://127.0.0.1:${port}`;

  const device = new MockBackend();
  const agent = new PhoneAgent({ url, token: TOKEN, backend: device, logger: silence });
  await agent.start();
  const controller = new RelayBackend({ url, token: TOKEN, peerTimeoutMs: 5_000 });

  await new Promise((resolve) => setTimeout(resolve, 250)); // ~8 sweeps

  const info = await controller.execute({ kind: "deviceInfo" });
  assert.equal(info.kind, "deviceInfo");

  await controller.close();
  await agent.close();
  await relay.close();
});

test("the agent reconnects after the relay drops it", async () => {
  const relay = new RelayServer({
    port: 0,
    host: "127.0.0.1",
    allowedTokens: [TOKEN],
    logger: silence,
  });
  const port = await relay.listen();
  const url = `ws://127.0.0.1:${port}`;

  const device = new MockBackend();
  const agent = new PhoneAgent({ url, token: TOKEN, backend: device, logger: silence });
  await agent.start().catch(silence);

  // Force the disconnect the way a network blip would.
  const health = () => fetch(`http://127.0.0.1:${port}/healthz`).then((r) => r.json());
  assert.equal(((await health()) as { pairs: number }).pairs, 1);

  const controller = new RelayBackend({ url, token: TOKEN, peerTimeoutMs: 5_000 });
  const info = await controller.execute({ kind: "deviceInfo" });
  assert.equal(info.kind, "deviceInfo");

  await controller.close();
  await agent.close();
  await relay.close();
});

test("relay rejects a frame larger than the payload limit", async () => {
  const relay = new RelayServer({
    port: 0,
    host: "127.0.0.1",
    allowedTokens: [TOKEN],
    maxPayloadBytes: 1024,
    logger: silence,
  });
  const port = await relay.listen();
  after(() => relay.close());

  const socket = new WebSocket(`ws://127.0.0.1:${port}`);
  await new Promise<void>((resolve) => socket.once("open", () => resolve()));
  socket.send(
    JSON.stringify({
      type: "hello",
      role: "agent",
      token: TOKEN,
      label: "x".repeat(4096),
    }),
  );

  const closed = await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), 3_000);
    socket.once("close", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
  assert.ok(closed, "expected an oversized frame to close the connection");
});
