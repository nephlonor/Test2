import assert from "node:assert/strict";
import { after, test } from "node:test";
import { MockBackend } from "../src/backends/mock.ts";
import { RelayBackend } from "../src/backends/relay.ts";
import { RelayServer } from "../src/relay/server.ts";
import { PhoneAgent } from "../src/agent/phone-agent.ts";

const TOKEN = "test-pairing-token-0123456789";
const silence = () => {};

/**
 * Stands up the full path — controller -> relay -> agent -> device — over
 * loopback sockets, with only the physical iPhone replaced by MockBackend.
 */
async function stack(options: { tokens?: string[] } = {}) {
  const relay = new RelayServer({
    port: 0,
    host: "127.0.0.1",
    allowedTokens: options.tokens ?? [TOKEN],
    logger: silence,
  });
  const port = await relay.listen();
  const url = `ws://127.0.0.1:${port}`;

  const device = new MockBackend();
  const agent = new PhoneAgent({ url, token: TOKEN, backend: device, logger: silence });
  await agent.start();

  const controller = new RelayBackend({
    url,
    token: TOKEN,
    peerTimeoutMs: 5_000,
    requestTimeoutMs: 5_000,
  });

  const teardown = async () => {
    await controller.close();
    await agent.close();
    await relay.close();
  };
  return { relay, agent, controller, device, url, teardown };
}

test("a command travels controller -> relay -> agent -> device", async () => {
  const s = await stack();
  after(() => s.teardown());

  const info = await s.controller.execute({ kind: "deviceInfo" });
  assert.equal(info.kind, "deviceInfo");
  assert.equal(info.kind === "deviceInfo" ? info.name : null, "Mock iPhone");
  assert.deepEqual(
    s.device.commands.map((c) => c.kind),
    ["deviceInfo"],
  );
});

test("a multi-step flow drives the device across screens", async () => {
  const s = await stack();
  after(() => s.teardown());

  const screen = await s.controller.execute({ kind: "describeScreen" });
  assert.equal(screen.kind, "screen");
  const settings =
    screen.kind === "screen" ? screen.elements.find((e) => e.label === "Settings") : undefined;
  assert.ok(settings, "expected a Settings icon on the home screen");

  const [x, y, w, h] = settings.rect;
  await s.controller.execute({ kind: "tap", at: { x: x + w / 2, y: y + h / 2 } });
  assert.equal(s.device.activeApp, "com.apple.Preferences");

  await s.controller.execute({ kind: "pressButton", button: "home" });
  assert.equal(s.device.activeApp, "com.apple.springboard");
});

test("device errors propagate back across the relay with their message", async () => {
  const s = await stack();
  after(() => s.teardown());

  await assert.rejects(
    () => s.controller.execute({ kind: "tap", at: { x: 999, y: 999 } }),
    /nothing tappable/,
  );
});

test("screenshot bytes survive the round trip", async () => {
  const s = await stack();
  after(() => s.teardown());

  const result = await s.controller.execute({ kind: "screenshot" });
  assert.equal(result.kind, "screenshot");
  const direct = await s.device.execute({ kind: "screenshot" });
  assert.equal(
    result.kind === "screenshot" ? result.pngBase64 : "a",
    direct.kind === "screenshot" ? direct.pngBase64 : "b",
  );
});

test("concurrent commands are matched to their own responses", async () => {
  const s = await stack();
  after(() => s.teardown());

  const [info, screen, shot] = await Promise.all([
    s.controller.execute({ kind: "deviceInfo" }),
    s.controller.execute({ kind: "describeScreen" }),
    s.controller.execute({ kind: "screenshot" }),
  ]);

  assert.equal(info.kind, "deviceInfo");
  assert.equal(screen.kind, "screen");
  assert.equal(shot.kind, "screenshot");
});

test("the relay rejects an unknown pairing token", async () => {
  const relay = new RelayServer({
    port: 0,
    host: "127.0.0.1",
    allowedTokens: ["the-only-valid-token-000000"],
    logger: silence,
  });
  const port = await relay.listen();
  after(() => relay.close());

  const controller = new RelayBackend({
    url: `ws://127.0.0.1:${port}`,
    token: "an-entirely-different-token",
    peerTimeoutMs: 1_000,
    requestTimeoutMs: 1_000,
  });

  // The failure must name the token, not blame a missing phone, and must not
  // wait out the peer timeout.
  const started = Date.now();
  await assert.rejects(() => controller.execute({ kind: "deviceInfo" }), /pairing token/);
  assert.ok(Date.now() - started < 900, "auth failure should be reported promptly");
  await controller.close();
});

test("a controller alone is told the phone is not connected", async () => {
  const relay = new RelayServer({
    port: 0,
    host: "127.0.0.1",
    allowedTokens: [TOKEN],
    logger: silence,
  });
  const port = await relay.listen();
  after(() => relay.close());

  const controller = new RelayBackend({
    url: `ws://127.0.0.1:${port}`,
    token: TOKEN,
    peerTimeoutMs: 500,
    requestTimeoutMs: 2_000,
  });

  await assert.rejects(() => controller.execute({ kind: "tap", at: { x: 1, y: 1 } }), /agent/);
  await controller.close();
});

test("two device pairs on one relay stay isolated", async () => {
  const tokenA = "pair-a-token-00000000000";
  const tokenB = "pair-b-token-00000000000";
  const relay = new RelayServer({
    port: 0,
    host: "127.0.0.1",
    allowedTokens: [tokenA, tokenB],
    logger: silence,
  });
  const port = await relay.listen();
  const url = `ws://127.0.0.1:${port}`;

  const deviceA = new MockBackend({ deviceName: "Phone A" });
  const deviceB = new MockBackend({ deviceName: "Phone B" });
  const agentA = new PhoneAgent({ url, token: tokenA, backend: deviceA, logger: silence });
  const agentB = new PhoneAgent({ url, token: tokenB, backend: deviceB, logger: silence });
  await Promise.all([agentA.start(), agentB.start()]);

  const controllerA = new RelayBackend({ url, token: tokenA, peerTimeoutMs: 5_000 });
  const infoA = await controllerA.execute({ kind: "deviceInfo" });

  assert.equal(infoA.kind === "deviceInfo" ? infoA.name : null, "Phone A");
  assert.equal(deviceB.commands.length, 0, "phone B should not have seen phone A's traffic");

  await controllerA.close();
  await agentA.close();
  await agentB.close();
  await relay.close();
});
