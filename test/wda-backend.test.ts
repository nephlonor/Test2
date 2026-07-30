import assert from "node:assert/strict";
import { test } from "node:test";
import { WdaBackend, flattenTree } from "../src/backends/wda.ts";

/** Minimal fake WDA that records requests and replays canned replies. */
function fakeWda(routes: Record<string, unknown>) {
  const seen: Array<{ method: string; path: string; body: unknown }> = [];
  const impl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const path = url.pathname + url.search;
    seen.push({
      method: init?.method ?? "GET",
      path,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    const value = path in routes ? routes[path] : { value: null };
    return new Response(JSON.stringify(value), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  return { impl, seen };
}

const SESSION = { value: { sessionId: "s1" }, sessionId: "s1" };

test("tap creates a session once and reuses it", async () => {
  const { impl, seen } = fakeWda({
    "/session": SESSION,
    "/session/s1/wda/tap": { value: null },
  });
  const wda = new WdaBackend({ baseUrl: "http://phone:8100", fetchImpl: impl });

  await wda.execute({ kind: "tap", at: { x: 5, y: 6 } });
  await wda.execute({ kind: "tap", at: { x: 7, y: 8 } });

  assert.equal(seen.filter((r) => r.path === "/session").length, 1);
  assert.deepEqual(seen.at(-1), {
    method: "POST",
    path: "/session/s1/wda/tap",
    body: { x: 7, y: 8 },
  });
});

test("surfaces a WDA error returned with HTTP 200", async () => {
  const { impl } = fakeWda({
    "/session": SESSION,
    "/session/s1/wda/apps/launch": {
      value: { error: "invalid argument", message: "bundle id not found" },
    },
  });
  const wda = new WdaBackend({ baseUrl: "http://phone:8100", fetchImpl: impl });

  await assert.rejects(
    () => wda.execute({ kind: "launchApp", bundleId: "com.example.nope" }),
    /invalid argument: bundle id not found/,
  );
});

test("a dead session is dropped so the next call reconnects", async () => {
  let failNext = true;
  const seen: string[] = [];
  const impl: typeof fetch = async (input, init) => {
    const path = new URL(String(input)).pathname;
    seen.push(path);
    if (path === "/session") {
      return Response.json({ value: { sessionId: "s1" }, sessionId: "s1" });
    }
    if (failNext) {
      failNext = false;
      return Response.json({ value: { error: "invalid session id", message: "session does not exist" } });
    }
    return Response.json({ value: null });
  };
  const wda = new WdaBackend({ baseUrl: "http://phone:8100", fetchImpl: impl });

  await assert.rejects(() => wda.execute({ kind: "tap", at: { x: 1, y: 1 } }));
  await wda.execute({ kind: "tap", at: { x: 1, y: 1 } });

  assert.equal(seen.filter((p) => p === "/session").length, 2);
});

test("reports an unreachable device clearly", async () => {
  const impl: typeof fetch = async () => {
    throw new Error("ECONNREFUSED");
  };
  const wda = new WdaBackend({ baseUrl: "http://phone:8100", fetchImpl: impl });
  await assert.rejects(() => wda.execute({ kind: "screenshot" }), /unreachable/);
});

test("flattenTree keeps labelled visible nodes in reading order", () => {
  const elements = flattenTree({
    type: "Application",
    rect: { x: 0, y: 0, width: 393, height: 852 },
    children: [
      {
        type: "Button",
        label: "Done",
        rect: { x: 300, y: 60, width: 60, height: 30 },
        isEnabled: "1",
        isVisible: "1",
      },
      {
        type: "StaticText",
        label: "Hidden",
        rect: { x: 0, y: 0, width: 10, height: 10 },
        isVisible: false,
      },
      {
        type: "Other",
        label: "Zero size",
        rect: { x: 0, y: 0, width: 0, height: 0 },
        isVisible: true,
      },
      {
        type: "TextField",
        value: "hello@example.com",
        rect: { x: 20, y: 200, width: 350, height: 44 },
        isEnabled: false,
        isVisible: true,
      },
    ],
  });

  assert.deepEqual(
    elements.map((e) => [e.type, e.label ?? e.value, e.enabled]),
    [
      ["Button", "Done", true],
      ["TextField", "hello@example.com", false],
    ],
  );
});
