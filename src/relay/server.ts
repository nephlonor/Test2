import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type Server } from "node:http";
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
  /**
   * How often to ping each endpoint. An endpoint that misses two consecutive
   * pings is terminated. Set to 0 to disable.
   */
  heartbeatMs?: number;
  /**
   * Largest frame the relay will accept. Screenshots dominate: a full-res PNG
   * from a modern iPhone is a few MB once base64-encoded.
   */
  maxPayloadBytes?: number;
  logger?: (message: string) => void;
}

interface Endpoint {
  socket: WebSocket;
  role: Hello["role"];
  label: string;
  /** Cleared on pong; a second sweep without a pong terminates the socket. */
  awaitingPong: boolean;
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
  #http: Server | null = null;
  #pairs = new Map<string, Pair>();
  #allowed: Buffer[] | null;
  #helloTimeoutMs: number;
  #heartbeatMs: number;
  #maxPayloadBytes: number;
  #heartbeat: NodeJS.Timeout | null = null;
  #log: (message: string) => void;
  #port: number;
  #host: string;

  constructor(options: RelayOptions = {}) {
    this.#port = options.port ?? 8787;
    this.#host = options.host ?? "0.0.0.0";
    this.#helloTimeoutMs = options.helloTimeoutMs ?? 10_000;
    this.#heartbeatMs = options.heartbeatMs ?? 30_000;
    this.#maxPayloadBytes = options.maxPayloadBytes ?? 16 * 1024 * 1024;
    this.#log = options.logger ?? ((m) => console.error(`[relay] ${m}`));
    this.#allowed =
      options.allowedTokens && options.allowedTokens.length > 0
        ? options.allowedTokens.map(hashToken)
        : null;
  }

  /** Resolves with the port actually bound (useful when port 0 is requested). */
  async listen(): Promise<number> {
    // An HTTP server underneath gives load balancers something to health-check;
    // WebSocket upgrades ride on the same port.
    const http = createServer((req, res) => {
      if (req.url === "/healthz") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, pairs: this.#pairs.size }));
        return;
      }
      res.writeHead(404).end();
    });
    this.#http = http;

    const wss = new WebSocketServer({ server: http, maxPayload: this.#maxPayloadBytes });
    this.#wss = wss;

    await new Promise<void>((resolve, reject) => {
      http.once("error", reject);
      http.listen(this.#port, this.#host, () => {
        http.removeListener("error", reject);
        resolve();
      });
    });

    wss.on("connection", (socket) => this.#onConnection(socket));

    if (this.#heartbeatMs > 0) {
      this.#heartbeat = setInterval(() => this.#sweep(), this.#heartbeatMs);
      this.#heartbeat.unref?.();
    }

    const address = http.address();
    const port = typeof address === "object" && address ? address.port : this.#port;
    this.#log(`listening on ${this.#host}:${port}`);
    return port;
  }

  async close(): Promise<void> {
    const wss = this.#wss;
    const http = this.#http;
    if (!wss || !http) return;
    this.#wss = null;
    this.#http = null;
    if (this.#heartbeat) clearInterval(this.#heartbeat);
    this.#heartbeat = null;

    for (const pair of this.#pairs.values()) {
      pair.controller?.socket.close(1001, "relay shutting down");
      pair.agent?.socket.close(1001, "relay shutting down");
    }
    this.#pairs.clear();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    await new Promise<void>((resolve) => http.close(() => resolve()));
  }

  /**
   * Drops endpoints that stopped answering pings. Without this a phone that
   * loses cellular leaves a half-open socket, and the relay keeps routing
   * commands into a void until TCP eventually gives up minutes later.
   */
  #sweep(): void {
    for (const pair of this.#pairs.values()) {
      for (const endpoint of [pair.controller, pair.agent]) {
        if (!endpoint) continue;
        if (endpoint.awaitingPong) {
          this.#log(`${endpoint.role} "${endpoint.label}" missed heartbeat; terminating`);
          endpoint.socket.terminate();
          continue;
        }
        endpoint.awaitingPong = true;
        try {
          endpoint.socket.ping();
        } catch {
          endpoint.socket.terminate();
        }
      }
    }
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
          awaitingPong: false,
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

    socket.on("pong", () => {
      if (endpoint) endpoint.awaitingPong = false;
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
