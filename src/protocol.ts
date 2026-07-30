/**
 * Wire protocol shared by all three processes.
 *
 * The same `DeviceCommand` value travels the whole path:
 *
 *   MCP server -> relay client -> [relay] -> phone agent -> WebDriverAgent
 *
 * Keeping one command type end to end means the relay never has to understand
 * device semantics; it only routes envelopes between a paired agent and
 * controller.
 */

import { z } from "zod";

/** Screen coordinates in points (not pixels), matching WebDriverAgent. */
export const PointSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
});
export type Point = z.infer<typeof PointSchema>;

export const DeviceCommandSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("screenshot") }),
  z.object({ kind: z.literal("describeScreen") }),
  z.object({ kind: z.literal("tap"), at: PointSchema }),
  z.object({
    kind: z.literal("swipe"),
    from: PointSchema,
    to: PointSchema,
    /** Gesture duration in seconds. WDA treats this as the press duration. */
    durationSec: z.number().positive().max(10).default(0.25),
  }),
  z.object({ kind: z.literal("type"), text: z.string().max(4096) }),
  z.object({ kind: z.literal("pressButton"), button: z.enum(["home", "volumeUp", "volumeDown"]) }),
  z.object({ kind: z.literal("launchApp"), bundleId: z.string().min(1) }),
  z.object({ kind: z.literal("deviceInfo") }),
]);
export type DeviceCommand = z.infer<typeof DeviceCommandSchema>;
export type DeviceCommandKind = DeviceCommand["kind"];

/** A single element in the accessibility tree, flattened for the model. */
export const ScreenElementSchema = z.object({
  type: z.string(),
  label: z.string().optional(),
  value: z.string().optional(),
  /** [x, y, width, height] in points. */
  rect: z.tuple([z.number(), z.number(), z.number(), z.number()]),
  enabled: z.boolean(),
});
export type ScreenElement = z.infer<typeof ScreenElementSchema>;

export const DeviceResultSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("ok") }),
  z.object({
    kind: z.literal("screenshot"),
    /** Base64-encoded PNG. */
    pngBase64: z.string(),
  }),
  z.object({
    kind: z.literal("screen"),
    elements: z.array(ScreenElementSchema),
    /** Bundle id of the app in the foreground, when WDA can report it. */
    activeApp: z.string().optional(),
  }),
  z.object({
    kind: z.literal("deviceInfo"),
    name: z.string(),
    iosVersion: z.string(),
    screen: z.object({ width: z.number(), height: z.number() }),
  }),
]);
export type DeviceResult = z.infer<typeof DeviceResultSchema>;

/**
 * Which result each command produces. Used by callers to narrow without a
 * runtime check at every call site.
 */
export type ResultFor<K extends DeviceCommandKind> = K extends "screenshot"
  ? Extract<DeviceResult, { kind: "screenshot" }>
  : K extends "describeScreen"
    ? Extract<DeviceResult, { kind: "screen" }>
    : K extends "deviceInfo"
      ? Extract<DeviceResult, { kind: "deviceInfo" }>
      : Extract<DeviceResult, { kind: "ok" }>;

// --- Relay envelopes -------------------------------------------------------

/**
 * Sent by both sides immediately after connecting. The relay pairs one
 * `controller` with one `agent` that present the same pairing token.
 */
export const HelloSchema = z.object({
  type: z.literal("hello"),
  role: z.enum(["controller", "agent"]),
  /** Shared secret identifying the device pair. Never logged. */
  token: z.string().min(16),
  /** Human-readable, for relay diagnostics only. */
  label: z.string().max(64).optional(),
});
export type Hello = z.infer<typeof HelloSchema>;

export const RequestSchema = z.object({
  type: z.literal("request"),
  id: z.string().min(1),
  command: DeviceCommandSchema,
});
export type Request = z.infer<typeof RequestSchema>;

export const ResponseSchema = z.object({
  type: z.literal("response"),
  id: z.string().min(1),
  result: DeviceResultSchema.optional(),
  error: z.string().optional(),
});
export type Response = z.infer<typeof ResponseSchema>;

/** Relay -> endpoint notifications about the peer's presence. */
export const PeerStateSchema = z.object({
  type: z.literal("peer"),
  state: z.enum(["connected", "disconnected"]),
});
export type PeerState = z.infer<typeof PeerStateSchema>;

export const EnvelopeSchema = z.discriminatedUnion("type", [
  HelloSchema,
  RequestSchema,
  ResponseSchema,
  PeerStateSchema,
]);
export type Envelope = z.infer<typeof EnvelopeSchema>;

export function parseEnvelope(raw: string): Envelope {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error("envelope is not valid JSON");
  }
  const parsed = EnvelopeSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error(`malformed envelope: ${parsed.error.issues[0]?.message ?? "unknown"}`);
  }
  return parsed.data;
}

export function encodeEnvelope(envelope: Envelope): string {
  return JSON.stringify(envelope);
}
