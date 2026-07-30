import assert from "node:assert/strict";
import { test } from "node:test";
import { MockBackend } from "../src/backends/mock.ts";
import { DeviceError } from "../src/backends/types.ts";

test("tapping an icon navigates to the linked app", async () => {
  const device = new MockBackend();
  assert.equal(device.activeApp, "com.apple.springboard");

  // Center of the Settings icon at rect [24, 100, 60, 60].
  await device.execute({ kind: "tap", at: { x: 54, y: 130 } });
  assert.equal(device.activeApp, "com.apple.Preferences");
});

test("home button returns to springboard", async () => {
  const device = new MockBackend({ initialApp: "com.apple.Preferences" });
  await device.execute({ kind: "pressButton", button: "home" });
  assert.equal(device.activeApp, "com.apple.springboard");
});

test("tapping empty space is an error, not a silent no-op", async () => {
  const device = new MockBackend();
  await assert.rejects(
    () => device.execute({ kind: "tap", at: { x: 300, y: 700 } }),
    (error: unknown) => error instanceof DeviceError && /nothing tappable/.test(error.message),
  );
});

test("launching an app that is not installed fails", async () => {
  const device = new MockBackend();
  await assert.rejects(
    () => device.execute({ kind: "launchApp", bundleId: "com.example.nope" }),
    /no app installed/,
  );
});

test("records every command in order", async () => {
  const device = new MockBackend();
  await device.execute({ kind: "deviceInfo" });
  await device.execute({ kind: "type", text: "hello" });
  assert.deepEqual(
    device.commands.map((c) => c.kind),
    ["deviceInfo", "type"],
  );
  assert.deepEqual(device.typed, ["hello"]);
});

test("screenshot returns decodable png bytes", async () => {
  const device = new MockBackend();
  const result = await device.execute({ kind: "screenshot" });
  assert.equal(result.kind, "screenshot");
  const bytes = Buffer.from(result.kind === "screenshot" ? result.pngBase64 : "", "base64");
  assert.deepEqual([...bytes.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
});
