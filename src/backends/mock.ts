import type { DeviceCommand, DeviceResult, ScreenElement } from "../protocol.ts";
import { DeviceError, type DeviceBackend } from "./types.ts";

/** A screen the mock can be sitting on, keyed by bundle id. */
export interface MockScreen {
  elements: ScreenElement[];
  /** Tapping an element with this label navigates to another bundle id. */
  links?: Record<string, string>;
}

export interface MockOptions {
  screens?: Record<string, MockScreen>;
  initialApp?: string;
  deviceName?: string;
  iosVersion?: string;
  screenSize?: { width: number; height: number };
}

const HOME: MockScreen = {
  elements: [
    { type: "Icon", label: "Settings", rect: [24, 100, 60, 60], enabled: true },
    { type: "Icon", label: "Notes", rect: [104, 100, 60, 60], enabled: true },
  ],
  links: { Settings: "com.apple.Preferences", Notes: "com.apple.mobilenotes" },
};

// 1x1 transparent PNG, enough for callers to prove the pipe carries image bytes.
const BLANK_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

/**
 * In-memory iPhone. Records every command so tests can assert on the exact
 * gesture sequence, and models just enough navigation to exercise multi-step
 * flows.
 */
export class MockBackend implements DeviceBackend {
  readonly name = "mock";
  readonly commands: DeviceCommand[] = [];
  /** Text accumulated by `type`, per app, mirroring a focused text field. */
  readonly typed: string[] = [];

  #screens: Record<string, MockScreen>;
  #activeApp: string;
  #size: { width: number; height: number };
  #deviceName: string;
  #iosVersion: string;
  #closed = false;

  constructor(options: MockOptions = {}) {
    this.#screens = options.screens ?? { "com.apple.springboard": HOME };
    this.#activeApp = options.initialApp ?? "com.apple.springboard";
    this.#size = options.screenSize ?? { width: 393, height: 852 };
    this.#deviceName = options.deviceName ?? "Mock iPhone";
    this.#iosVersion = options.iosVersion ?? "18.0";
  }

  get activeApp(): string {
    return this.#activeApp;
  }

  async execute(command: DeviceCommand): Promise<DeviceResult> {
    if (this.#closed) throw new DeviceError("backend is closed", command.kind);
    this.commands.push(command);

    switch (command.kind) {
      case "screenshot":
        return { kind: "screenshot", pngBase64: BLANK_PNG };

      case "describeScreen":
        return {
          kind: "screen",
          elements: this.#currentScreen().elements,
          activeApp: this.#activeApp,
        };

      case "tap": {
        const hit = this.#elementAt(command.at.x, command.at.y);
        if (!hit) throw new DeviceError(`nothing tappable at (${command.at.x}, ${command.at.y})`, "tap");
        if (!hit.enabled) throw new DeviceError(`element "${hit.label ?? hit.type}" is disabled`, "tap");
        const target = hit.label ? this.#currentScreen().links?.[hit.label] : undefined;
        if (target) this.#activeApp = target;
        return { kind: "ok" };
      }

      case "swipe":
      case "pressButton":
        if (command.kind === "pressButton" && command.button === "home") {
          this.#activeApp = "com.apple.springboard";
        }
        return { kind: "ok" };

      case "type":
        this.typed.push(command.text);
        return { kind: "ok" };

      case "launchApp":
        if (!(command.bundleId in this.#screens)) {
          throw new DeviceError(`no app installed with bundle id "${command.bundleId}"`, "launchApp");
        }
        this.#activeApp = command.bundleId;
        return { kind: "ok" };

      case "deviceInfo":
        return {
          kind: "deviceInfo",
          name: this.#deviceName,
          iosVersion: this.#iosVersion,
          screen: { ...this.#size },
        };
    }
  }

  async close(): Promise<void> {
    this.#closed = true;
  }

  #currentScreen(): MockScreen {
    return this.#screens[this.#activeApp] ?? { elements: [] };
  }

  /** Topmost element whose rect contains the point; later elements win. */
  #elementAt(x: number, y: number): ScreenElement | undefined {
    const hits = this.#currentScreen().elements.filter((el) => {
      const [ex, ey, w, h] = el.rect;
      return x >= ex && x <= ex + w && y >= ey && y <= ey + h;
    });
    return hits.at(-1);
  }
}
