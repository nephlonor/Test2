import type { DeviceCommand, DeviceResult, ScreenElement } from "../protocol.ts";
import { DeviceError, type DeviceBackend } from "./types.ts";

export interface WdaOptions {
  /** Base URL of the WebDriverAgent HTTP server, e.g. http://127.0.0.1:8100 */
  baseUrl: string;
  /** Per-request timeout in ms. */
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/** WDA wraps every reply in `{ value: ... }` and signals failure inside it. */
interface WdaEnvelope<T> {
  value: T;
  sessionId?: string;
}

/** One node of WDA's `/source?format=json` accessibility tree. */
interface WdaNode {
  type?: string;
  label?: string | null;
  name?: string | null;
  value?: string | null;
  rect?: { x: number; y: number; width: number; height: number };
  isEnabled?: boolean | string;
  isVisible?: boolean | string;
  children?: WdaNode[];
}

/**
 * Talks to WebDriverAgent running on the phone.
 *
 * WDA must already be installed and running on the device — that part needs a
 * Mac and Xcode once, at install time. Everything after that is plain HTTP, so
 * this client works from anywhere that can reach `baseUrl` (in practice, the
 * phone-side agent reaching localhost, or a tunnel).
 */
export class WdaBackend implements DeviceBackend {
  readonly name = "webdriveragent";

  #baseUrl: string;
  #timeoutMs: number;
  #fetch: typeof fetch;
  #sessionId: string | null = null;
  /** De-dupes concurrent session creation. */
  #sessionPromise: Promise<string> | null = null;

  constructor(options: WdaOptions) {
    this.#baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.#timeoutMs = options.timeoutMs ?? 30_000;
    this.#fetch = options.fetchImpl ?? fetch;
  }

  async execute(command: DeviceCommand): Promise<DeviceResult> {
    switch (command.kind) {
      case "screenshot": {
        // Screenshots are session-independent in WDA.
        const png = await this.#get<string>("/screenshot", command.kind);
        return { kind: "screenshot", pngBase64: png };
      }

      case "describeScreen": {
        const session = await this.#session(command.kind);
        const root = await this.#get<WdaNode | string>(
          `/session/${session}/source?format=json`,
          command.kind,
        );
        // WDA returns a string when format=json is unsupported for the tree.
        const tree: WdaNode = typeof root === "string" ? (JSON.parse(root) as WdaNode) : root;
        return { kind: "screen", elements: flattenTree(tree) };
      }

      case "tap": {
        const session = await this.#session(command.kind);
        await this.#post(`/session/${session}/wda/tap`, command.kind, {
          x: command.at.x,
          y: command.at.y,
        });
        return { kind: "ok" };
      }

      case "swipe": {
        const session = await this.#session(command.kind);
        await this.#post(`/session/${session}/wda/dragfromtoforduration`, command.kind, {
          fromX: command.from.x,
          fromY: command.from.y,
          toX: command.to.x,
          toY: command.to.y,
          duration: command.durationSec,
        });
        return { kind: "ok" };
      }

      case "type": {
        const session = await this.#session(command.kind);
        // WDA takes an array of strings and concatenates them.
        await this.#post(`/session/${session}/wda/keys`, command.kind, {
          value: [command.text],
        });
        return { kind: "ok" };
      }

      case "pressButton": {
        const session = await this.#session(command.kind);
        await this.#post(`/session/${session}/wda/pressButton`, command.kind, {
          name: command.button,
        });
        return { kind: "ok" };
      }

      case "launchApp": {
        const session = await this.#session(command.kind);
        await this.#post(`/session/${session}/wda/apps/launch`, command.kind, {
          bundleId: command.bundleId,
        });
        return { kind: "ok" };
      }

      case "deviceInfo": {
        const status = await this.#get<{
          ios?: { simulatorVersion?: string; sdkVersion?: string };
          device?: string;
          build?: { productBundleIdentifier?: string };
        }>("/status", command.kind);
        const session = await this.#session(command.kind);
        const size = await this.#get<{ width: number; height: number }>(
          `/session/${session}/window/size`,
          command.kind,
        );
        return {
          kind: "deviceInfo",
          name: status.device ?? "iPhone",
          iosVersion: status.ios?.sdkVersion ?? status.ios?.simulatorVersion ?? "unknown",
          screen: { width: size.width, height: size.height },
        };
      }
    }
  }

  async close(): Promise<void> {
    const session = this.#sessionId;
    this.#sessionId = null;
    this.#sessionPromise = null;
    if (!session) return;
    try {
      await this.#request("DELETE", `/session/${session}`, "deviceInfo", undefined);
    } catch {
      // The session may already be gone; nothing useful to do on teardown.
    }
  }

  /**
   * Reuses the open WDA session, creating one on demand. If the device dropped
   * the session (app crash, reboot), the caller retries via `#request`.
   */
  async #session(kind: DeviceCommand["kind"]): Promise<string> {
    if (this.#sessionId) return this.#sessionId;
    this.#sessionPromise ??= (async () => {
      const created = await this.#request<WdaEnvelope<{ sessionId?: string }>>(
        "POST",
        "/session",
        kind,
        { capabilities: { alwaysMatch: { "apple:arguments": [] } } },
      );
      const id = created.sessionId ?? created.value?.sessionId;
      if (!id) throw new DeviceError("WebDriverAgent did not return a session id", kind);
      this.#sessionId = id;
      return id;
    })().finally(() => {
      this.#sessionPromise = null;
    });
    return this.#sessionPromise;
  }

  async #get<T>(path: string, kind: DeviceCommand["kind"]): Promise<T> {
    const body = await this.#request<WdaEnvelope<T>>("GET", path, kind, undefined);
    return body.value;
  }

  async #post<T>(path: string, kind: DeviceCommand["kind"], payload: unknown): Promise<T> {
    const body = await this.#request<WdaEnvelope<T>>("POST", path, kind, payload);
    return body.value;
  }

  async #request<T>(
    method: string,
    path: string,
    kind: DeviceCommand["kind"],
    payload: unknown,
  ): Promise<T> {
    const signal = AbortSignal.timeout(this.#timeoutMs);
    let response: Awaited<ReturnType<typeof fetch>>;
    try {
      response = await this.#fetch(`${this.#baseUrl}${path}`, {
        method,
        signal,
        headers: payload === undefined ? undefined : { "content-type": "application/json" },
        body: payload === undefined ? undefined : JSON.stringify(payload),
      });
    } catch (cause) {
      const reason = signal.aborted ? `timed out after ${this.#timeoutMs}ms` : String(cause);
      throw new DeviceError(`WebDriverAgent unreachable at ${this.#baseUrl}: ${reason}`, kind);
    }

    const text = await response.text();
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      throw new DeviceError(`WebDriverAgent returned non-JSON (HTTP ${response.status})`, kind);
    }

    const error = extractWdaError(parsed);
    if (error) {
      // A dead session is recoverable: drop it so the next call reconnects.
      if (/session (does not exist|is (invalid|terminated))/i.test(error)) {
        this.#sessionId = null;
      }
      throw new DeviceError(error, kind);
    }
    if (!response.ok) {
      throw new DeviceError(`WebDriverAgent HTTP ${response.status}`, kind);
    }
    return parsed as T;
  }
}

/** WDA reports failures as `value.error` / `value.message` with HTTP 200. */
function extractWdaError(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  const value = (body as { value?: unknown }).value;
  if (typeof value !== "object" || value === null) return null;
  const { error, message } = value as { error?: unknown; message?: unknown };
  if (typeof error !== "string" || error.length === 0) return null;
  return typeof message === "string" && message.length > 0 ? `${error}: ${message}` : error;
}

/**
 * Flattens WDA's nested tree into the elements a model can act on: visible,
 * non-zero-area nodes that carry a label or value.
 */
export function flattenTree(root: WdaNode): ScreenElement[] {
  const out: ScreenElement[] = [];
  const stack: WdaNode[] = [root];

  while (stack.length > 0) {
    const node = stack.pop();
    if (!node) continue;
    for (const child of node.children ?? []) stack.push(child);

    if (!truthy(node.isVisible, true)) continue;
    const rect = node.rect;
    if (!rect || rect.width <= 0 || rect.height <= 0) continue;

    const label = node.label ?? node.name ?? undefined;
    const value = node.value ?? undefined;
    if (!label && !value) continue;

    out.push({
      type: node.type ?? "Unknown",
      ...(label ? { label } : {}),
      ...(value ? { value: String(value) } : {}),
      rect: [rect.x, rect.y, rect.width, rect.height],
      enabled: truthy(node.isEnabled, true),
    });
  }

  // Stack traversal reverses sibling order; restore top-to-bottom reading order.
  return out.reverse();
}

/** WDA is inconsistent about booleans: sometimes `true`, sometimes `"1"`. */
function truthy(raw: boolean | string | undefined, fallback: boolean): boolean {
  if (raw === undefined) return fallback;
  if (typeof raw === "boolean") return raw;
  return raw === "1" || raw.toLowerCase() === "true";
}
