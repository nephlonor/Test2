import WebSocket from "ws";
import { encodeEnvelope, parseEnvelope } from "../protocol.ts";
import type { DeviceBackend } from "../backends/types.ts";

export interface PhoneAgentOptions {
  url: string;
  token: string;
  label?: string;
  backend: DeviceBackend;
  /**
   * Terminate the connection if nothing (not even a ping) arrives from the
   * relay in this long. Should exceed the relay's heartbeat interval.
   */
  idleTimeoutMs?: number;
  logger?: (message: string) => void;
  WebSocketImpl?: typeof WebSocket;
}

/**
 * Runs on the network side of the phone (a small always-on host, or the device
 * itself), dials the relay, and executes whatever the controller asks against
 * the local WebDriverAgent.
 *
 * It only ever makes outbound connections, so the phone needs no public address
 * and no port forwarding.
 */
export class PhoneAgent {
  #socket: WebSocket | null = null;
  #closed = false;
  #attempt = 0;
  #log: (message: string) => void;
  #WebSocketImpl: typeof WebSocket;
  #retryTimer: NodeJS.Timeout | null = null;
  #idleTimer: NodeJS.Timeout | null = null;
  #idleTimeoutMs: number;

  readonly #options: PhoneAgentOptions;

  constructor(options: PhoneAgentOptions) {
    this.#options = options;
    this.#idleTimeoutMs = options.idleTimeoutMs ?? 75_000;
    this.#log = options.logger ?? ((m) => console.error(`[agent] ${m}`));
    this.#WebSocketImpl = options.WebSocketImpl ?? WebSocket;
  }

  /** Connects once. Resolves when the socket is open and `hello` was sent. */
  async start(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const socket = new this.#WebSocketImpl(this.#options.url);
      this.#socket = socket;

      socket.on("open", () => {
        this.#attempt = 0;
        socket.send(
          encodeEnvelope({
            type: "hello",
            role: "agent",
            token: this.#options.token,
            label: this.#options.label ?? "iphone",
          }),
        );
        this.#log(`connected to relay at ${this.#options.url}`);
        this.#touch();
        resolve();
      });

      socket.on("message", (data) => {
        this.#touch();
        void this.#onMessage(data.toString());
      });

      // ws answers pings automatically; we only need them as a liveness signal.
      socket.on("ping", () => this.#touch());
      socket.on("pong", () => this.#touch());

      socket.on("close", (code, reason) => {
        this.#clearIdleTimer();
        if (this.#socket === socket) this.#socket = null;
        this.#log(`relay connection closed (${reason.toString() || `code ${code}`})`);
        reject(new Error(`relay connection closed (code ${code})`));
        // 4003 is an auth rejection; retrying with the same token is pointless.
        if (!this.#closed && code !== 4003) this.#scheduleReconnect();
      });

      socket.on("error", (error) => reject(error));
    });
  }

  /** Restarts the idle watchdog; any traffic counts as proof of life. */
  #touch(): void {
    if (this.#idleTimeoutMs <= 0 || this.#closed) return;
    this.#clearIdleTimer();
    this.#idleTimer = setTimeout(() => {
      this.#log(`no traffic from relay in ${this.#idleTimeoutMs}ms; reconnecting`);
      // terminate(), not close(): a half-open socket will not complete a
      // closing handshake, and we would wait forever for the reply.
      this.#socket?.terminate();
    }, this.#idleTimeoutMs);
    this.#idleTimer.unref?.();
  }

  #clearIdleTimer(): void {
    if (this.#idleTimer) clearTimeout(this.#idleTimer);
    this.#idleTimer = null;
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.#clearIdleTimer();
    if (this.#retryTimer) clearTimeout(this.#retryTimer);
    this.#socket?.close(1000, "agent shutting down");
    this.#socket = null;
    await this.#options.backend.close();
  }

  async #onMessage(raw: string): Promise<void> {
    let envelope;
    try {
      envelope = parseEnvelope(raw);
    } catch (error) {
      this.#log(`ignoring malformed envelope: ${(error as Error).message}`);
      return;
    }
    if (envelope.type === "peer") {
      this.#log(`controller ${envelope.state}`);
      return;
    }
    if (envelope.type !== "request") return;

    const socket = this.#socket;
    if (!socket) return;

    try {
      const result = await this.#options.backend.execute(envelope.command);
      socket.send(encodeEnvelope({ type: "response", id: envelope.id, result }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.#log(`${envelope.command.kind} failed: ${message}`);
      socket.send(encodeEnvelope({ type: "response", id: envelope.id, error: message }));
    }
  }

  #scheduleReconnect(): void {
    const delay = Math.min(30_000, 500 * 2 ** this.#attempt++);
    this.#log(`reconnecting in ${delay}ms`);
    this.#retryTimer = setTimeout(() => {
      if (this.#closed) return;
      this.start().catch(() => {
        /* the close handler schedules the next attempt */
      });
    }, delay);
  }
}
