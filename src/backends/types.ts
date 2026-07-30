import type { DeviceCommand, DeviceResult } from "../protocol.ts";

/**
 * Anything that can execute a device command: a real phone over
 * WebDriverAgent, a relay hop to a phone somewhere else, or a mock.
 */
export interface DeviceBackend {
  readonly name: string;
  execute(command: DeviceCommand): Promise<DeviceResult>;
  close(): Promise<void>;
}

/** Raised when a command is well-formed but the device refused or failed it. */
export class DeviceError extends Error {
  readonly command: DeviceCommand["kind"];

  constructor(message: string, command: DeviceCommand["kind"]) {
    super(message);
    this.name = "DeviceError";
    this.command = command;
  }
}
