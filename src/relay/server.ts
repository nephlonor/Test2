import { createHash, timingSafeEqual } from "node:crypto";
import { WebSocketServer, type WebSocket } from "ws";
import { encodeEnvelope, parseEnvelope, type Envelope, type Hello } from "../protocol.ts";

export interface RelayOptions {
  port?: number;
  host?: string;
  /**
   * Tokens allowed to pair, as raw secrets. Stored hashed; compared in constant
   * time. When omitted, any token of sufficient length is accepted — only
   * appropriate for local development.
   */
  allowedTokens?: string[];
  /** Time an endpoint has to send `hello` before it is dropped. */
  helloTimeoutMs?: number;
  logger?: (message: string) => void;
}

interface Endpoint {
  socket: WebSocket;
  role: Hello["role"];
  label: string;
}

/** One controller plus one agent sharing a pairing token. */
interface Pair {
  controller?: Endpoint;
  agent?: Endpoint;
}

/**
 * Rendezvous point between the sandbox and the phone.
 *
 * Neither side can accept inbound connections — the sandbox is ephemeral and
 * the phone sits behind carrier NAT — so both dial out to the relay and the
 * relay pipes bytes between them. It deliberately does not parse device
 * commands beyond validating the envelope shape.
 */
export class RelayServer {
  #wss: WebSocketServer | null = null;
  #pairs = new Map<string, Pair>();
  #allowed: Buffer[] | null;
  #helloTimeoutMs: number;
  #log: (message: string) => void;
  #port: number;
  #host: string;

  constructor(options: RelayOptions = {}) {
    this.#port = options.port ?? 8787;
    this.#host = options.host ?? "0.0.0.0";
    this.#helloTimeoutMs = options.helloTimeoutMs ?? 10_000;
    this.#log = options.logger ?? ((m) => console.error(`[relay] ${m}`));
    this.#allowed =
      options.allowedTokens && options.allowedTokens.length > 0
        ? options.allowedTokens.map(hashToken)
        : null;
  }

  /** Resolves with the port actually bound (useful when port 0 is requested). */
  async listen(): Promise<number> {
    const wss = new WebSocketServer({ port: this.#port, host: this.#host });
    this.#wss = wss;
    await new Promise<void>((resolve, reject) => {
      wss.once("listening", resolve);
      wss.once("error", reject);
    });
    wss.on("connection", (socket) => this.#onConnection(socket));
    const address = wss.address();
    const port = typeof address === "object" && address ? address.port : this.#port;
    this.#log(`listening on ${this.#host}:${port}`);
    return port;
  }

  async close(): Promise<void> {
    const wss = this.#wss;
    if (!wss) return;
    this.#wss = null;
    for (const pair of this.#pairs.values()) {
      pair.controller?.socket.close(1001, "relay shutting down");
      pair.agent?.socket.close(1001, "relay shutting down");
    }
    this.#pairs.clear();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
  }

  #onConnection(socket: WebSocket): void {
    let endpoint: Endpoint | null = null;
    let tokenKey: string | null = null;

    // Drop connections that never identify themselves.
    const timer = setTimeout(() => {
      if (!endpoint) socket.close(4008, "hello timeout");
    }, this.#helloTimeoutMs);

    socket.on("message", (data) => {
      let envelope: Envelope;
      try {
        envelope = parseEnvelope(data.toString());
      } catch (error) {
        socket.close(4000, (error as Error).message.slice(0, 120));
        return;
      }

      if (envelope.type === "hello") {
        if (endpoint) {
          socket.close(4002, "already registered");
          return;
        }
        if (!this.#tokenAllowed(envelope.token)) {
          this.#log(`rejected ${envelope.role}: unknown pairing token`);
          socket.close(4003, "unauthorized");
          return;
        }
        clearTimeout(timer);
        tokenKey = hashToken(envelope.token).toString("hex");
        endpoint = {
          socket,
          role: envelope.role,
          label: envelope.label ?? envelope.role,
        };
        this.#register(tokenKey, endpoint);
        return;
      }

      if (!endpoint || !tokenKey) {
        socket.close(4001, "hello required first");
        return;
      }

      // Everything else is opaque routing: controller <-> agent.
      const peer = this.#peerOf(tokenKey, endpoint.role);
      if (!peer) {
        if (envelope.type === "request") {
          socket.send(
            encodeEnvelope({
              type: "response",
              id: envelope.id,
              error: "phone agent is not connected",
            }),
          );
        }
        return;
      }
      peer.socket.send(encodeEnvelope(envelope));
    });

    socket.on("close", () => {
      clearTimeout(timer);
      if (!endpoint || !tokenKey) return;
      this.#unregister(tokenKey, endpoint);
    });

    socket.on("error", () => socket.close());
  }

  #register(tokenKey: string, endpoint: Endpoint): void {
    const pair = this.#pairs.get(tokenKey) ?? {};
    const existing = pair[endpoint.role];
    if (existing) {
      // Last writer wins: a reconnecting sandbox should displace a stale socket.
      existing.socket.close(4009, "replaced by a newer connection");
    }
    pair[endpoint.role] = endpoint;
    this.#pairs.set(tokenKey, pair);
    this.#log(`${endpoint.role} "${endpoint.label}" connected`);

    const peer = this.#peerOf(tokenKey, endpoint.role);
    if (peer) {
      const notice = encodeEnvelope({ type: "peer", state: "connected" });
      endpoint.socket.send(notice);
      peer.socket.send(notice);
    }
  }

  #unregister(tokenKey: string, endpoint: Endpoint): void {
    const pair = this.#pairs.get(tokenKey);
    if (!pair || pair[endpoint.role] !== endpoint) return;
    delete pair[endpoint.role];
    this.#log(`${endpoint.role} "${endpoint.label}" disconnected`);

    const peer = this.#peerOf(tokenKey, endpoint.role);
    if (peer) {
      peer.socket.send(encodeEnvelope({ type: "peer", state: "disconnected" }));
    } else {
      this.#pairs.delete(tokenKey);
    }
  }

  #peerOf(tokenKey: string, role: Hello["role"]): Endpoint | undefined {
    const pair = this.#pairs.get(tokenKey);
    return role === "controller" ? pair?.agent : pair?.controller;
  }

  #tokenAllowed(token: string): boolean {
    if (!this.#allowed) return true;
    const candidate = hashToken(token);
    // Compare against every entry so timing does not reveal list position.
    let matched = false;
    for (const known of this.#allowed) {
      if (timingSafeEqual(candidate, known)) matched = true;
    }
    return matched;
  }
}

/** Fixed-width digest so token comparison is constant time. */
function hashToken(token: string): Buffer {
  return createHash("sha256").update(token, "utf8").digest();
}
