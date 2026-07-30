import assert from "node:assert/strict";
import { test } from "node:test";
import { DeviceCommandSchema, encodeEnvelope, parseEnvelope } from "../src/protocol.ts";

test("swipe defaults its duration", () => {
  const parsed = DeviceCommandSchema.parse({
    kind: "swipe",
    from: { x: 0, y: 0 },
    to: { x: 10, y: 10 },
  });
  assert.equal(parsed.kind, "swipe");
  assert.equal(parsed.kind === "swipe" ? parsed.durationSec : null, 0.25);
});

test("rejects a command with an unknown kind", () => {
  assert.throws(() => DeviceCommandSchema.parse({ kind: "jailbreak" }));
});

test("rejects non-finite coordinates", () => {
  assert.throws(() =>
    DeviceCommandSchema.parse({ kind: "tap", at: { x: Number.POSITIVE_INFINITY, y: 0 } }),
  );
});

test("round-trips an envelope", () => {
  const envelope = encodeEnvelope({
    type: "request",
    id: "abc",
    command: { kind: "tap", at: { x: 1, y: 2 } },
  });
  const back = parseEnvelope(envelope);
  assert.equal(back.type, "request");
  assert.deepEqual(back.type === "request" ? back.command : null, {
    kind: "tap",
    at: { x: 1, y: 2 },
  });
});

test("parseEnvelope reports bad JSON and bad shape distinctly", () => {
  assert.throws(() => parseEnvelope("{nope"), /not valid JSON/);
  assert.throws(() => parseEnvelope('{"type":"nope"}'), /malformed envelope/);
});

test("hello requires a token long enough to be a secret", () => {
  assert.throws(() =>
    parseEnvelope(JSON.stringify({ type: "hello", role: "agent", token: "short" })),
  );
});
