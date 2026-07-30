import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import {
  encodeEnvelope,
  parseEnvelope,
  type DeviceCommand,
  type DeviceResult,
} from "../protocol.ts";
import { DeviceError, type DeviceBackend } from "./types.ts";

export interface RelayBackendOptions {
  /** Relay WebSocket URL, e.g. wss://relay.example.com */
  url: string;
  token: string;
  label?: string;
  /** How long to wait for a device response before giving up. */
  requestTimeoutMs?: number;
  /** How long to wait for the phone agent to show up. */
  peerTimeoutMs?: number;
  WebSocketImpl?: typeof WebSocket;
}

interface Pending {
  resolve: (result: DeviceResult) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  kind: DeviceCommand["kind"];
}

/**
 * Controller-side backend: forwards commands over the relay to the phone agent
 * and correlates responses by request id.
 *
 * Reconnects with backoff, because the sandbox may outlive transient network
 * drops and we do not want a single blip to kill an in-progress session.
 */
export class RelayBackend implements DeviceBackend {
  readonly name = "relay";

  #options: Required<Omit<RelayBackendOptions, "WebSocketImpl" | "label">> & { label: string };
  #WebSocketImpl: typeof WebSocket;
  #socket: WebSocket | null = null;
  #pending = new Map<string, Pending>();
  #peerConnected = false;
  #peerWaiters: Array<{ resolve: () => void; reject: (error: Error) => void }> = [];
  #closed = false;
  #connectPromise: Promise<void> | null = null;
  #reconnectAttempt = 0;

  constructor(options: RelayBackendOptions) {
    this.#options = {
      url: options.url,
      token: options.token,
      label: options.label ?? "claude-session",
      requestTimeoutMs: options.requestTimeoutMs ?? 60_000,
      peerTimeoutMs: options.peerTimeoutMs ?? 30_000,
    };
    this.#WebSocketImpl = options.WebSocketImpl ?? WebSocket;
  }

  get peerConnected(): boolean {
    return this.#peerConnected;
  }

  async execute(command: DeviceCommand): Promise<DeviceResult> {
    if (this.#closed) throw new DeviceError("relay backend is closed", command.kind);
    await this.#connect();
    await this.#awaitPeer(command.kind);

    const socket = this.#socket;
    if (!socket || socket.readyState !== this.#WebSocketImpl.OPEN) {
      throw new DeviceError("relay connection is not open", command.kind);
    }

    const id = randomUUID();
    return new Promise<DeviceResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(
          new DeviceError(
            `device did not respond within ${this.#options.requestTimeoutMs}ms`,
            command.kind,
          ),
        );
      }, this.#options.requestTimeoutMs);

      this.#pending.set(id, { resolve, reject, timer, kind: command.kind });
      socket.send(encodeEnvelope({ type: "request", id, command }));
    });
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.#failAllPending(new Error("relay backend closed"));
    this.#socket?.close(1000, "client closing");
    this.#socket = null;
  }

  #connect(): Promise<void> {
    if (this.#socket?.readyState === this.#WebSocketImpl.OPEN) return Promise.resolve();
    this.#connectPromise ??= new Promise<void>((resolve, reject) => {
      const socket = new this.#WebSocketImpl(this.#options.url);
      this.#socket = socket;

      socket.on("open", () => {
        this.#reconnectAttempt = 0;
        socket.send(
          encodeEnvelope({
            type: "hello",
            role: "controller",
            token: this.#options.token,
            label: this.#options.label,
          }),
        );
        resolve();
      });

      socket.on("message", (data) => this.#onMessage(data.toString()));

      socket.on("close", (code, reason) => {
        this.#peerConnected = false;
        if (this.#socket === socket) this.#socket = null;
        const detail = reason.toString() || `code ${code}`;
        // 4003 is the relay refusing our pairing token. Retrying cannot help,
        // and waiting out the peer timeout would report it as a missing phone.
        const error =
          code === 4003
            ? new Error("relay rejected the pairing token — check RELAY_TOKEN matches the relay")
            : new Error(`relay connection closed (${detail})`);
        this.#failAllPending(error);
        this.#failPeerWaiters(error);
        reject(error);
        if (!this.#closed && code !== 4003) this.#scheduleReconnect();
      });

      socket.on("error", (error) => reject(error));
    }).finally(() => {
      this.#connectPromise = null;
    });
    return this.#connectPromise;
  }

  #scheduleReconnect(): void {
    const delay = Math.min(30_000, 500 * 2 ** this.#reconnectAttempt++);
    const timer = setTimeout(() => {
      if (this.#closed) return;
      this.#connect().catch(() => {
        /* the close handler schedules the next attempt */
      });
    }, delay);
    // Never hold the process open just to retry.
    timer.unref?.();
  }

  #onMessage(raw: string): void {
    let envelope;
    try {
      envelope = parseEnvelope(raw);
    } catch {
      return; // Ignore garbage rather than tearing down a working session.
    }

    if (envelope.type === "peer") {
      this.#peerConnected = envelope.state === "connected";
      if (this.#peerConnected) {
        for (const waiter of this.#peerWaiters.splice(0)) waiter.resolve();
      }
      return;
    }

    if (envelope.type !== "response") return;
    const pending = this.#pending.get(envelope.id);
    if (!pending) return;
    this.#pending.delete(envelope.id);
    clearTimeout(pending.timer);

    if (envelope.error) {
      pending.reject(new DeviceError(envelope.error, pending.kind));
    } else if (envelope.result) {
      pending.resolve(envelope.result);
    } else {
      pending.reject(new DeviceError("relay returned an empty response", pending.kind));
    }
  }

  /** Blocks until the phone agent is on the other side of the relay. */
  #awaitPeer(kind: DeviceCommand["kind"]): Promise<void> {
    if (this.#peerConnected) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#peerWaiters = this.#peerWaiters.filter((w) => w !== waiter);
        reject(
          new DeviceError(
            `phone agent did not connect within ${this.#options.peerTimeoutMs}ms — is the agent running on the device?`,
            kind,
          ),
        );
      }, this.#options.peerTimeoutMs);

      const waiter = {
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
        reject: (error: Error) => {
          clearTimeout(timer);
          reject(error instanceof DeviceError ? error : new DeviceError(error.message, kind));
        },
      };
      this.#peerWaiters.push(waiter);
    });
  }

  #failPeerWaiters(error: Error): void {
    for (const waiter of this.#peerWaiters.splice(0)) waiter.reject(error);
  }

  #failAllPending(error: Error): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
  }
}
