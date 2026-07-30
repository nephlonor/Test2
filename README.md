# iphone-control

Drive a physical iPhone from a Claude session running in a remote sandbox — no
Mac running at the time, no cable, no simulator.

```
Claude session (remote sandbox)
      │  MCP over stdio
      ▼
  MCP server ──────► RelayBackend ──┐
                                    │  WebSocket (outbound only)
                              ┌─────▼─────┐
                              │   relay   │  public host, pairs by token
                              └─────▲─────┘
                                    │  WebSocket (outbound only)
                     phone agent ───┘
                          │  HTTP
                          ▼
                  WebDriverAgent ──► iPhone
```

Neither the sandbox nor the phone can accept inbound connections, so both dial
out to the relay and it pipes commands between them. The relay never interprets
device commands — it validates the envelope and routes.

## The one honest caveat

iOS does not let arbitrary software drive other apps. The only supported path is
**WebDriverAgent**, Appium's XCTest-based runner, which has to be built and
signed with Xcode and installed on the device **once**. After that it runs on
the phone and exposes a plain HTTP API, which is what makes the "no Mac running,
no cable" part true at *runtime*.

If you have never installed WDA on the device, you need a Mac for that one step.
There is no way around it that does not involve jailbreaking.

## Components

| Path | What it is |
| --- | --- |
| `src/protocol.ts` | The command/result/envelope types every layer speaks, with Zod validation at each boundary. |
| `src/mcp/` | MCP server exposing `tap`, `swipe`, `type_text`, `screenshot`, `describe_screen`, `launch_app`, `press_button`, `device_info`. |
| `src/relay/` | WebSocket rendezvous server. Pairs one controller with one agent per token, compared in constant time. |
| `src/agent/` | Phone-side agent. Dials the relay, executes commands against local WDA. |
| `src/backends/` | `DeviceBackend` implementations: `wda` (real phone), `relay` (across the relay), `mock` (no hardware). |

## Running it

Install and check:

```bash
npm install
npm test          # 25 tests, including a full end-to-end run over real sockets
npm run typecheck
npm run build
```

### 1. Relay (on a public host)

```bash
RELAY_TOKENS=$(openssl rand -hex 24) PORT=8787 npm run relay
```

Put TLS in front of it. The relay speaks plain WebSocket and expects to sit
behind a terminating proxy.

### 2. Phone agent (where it can reach WebDriverAgent)

```bash
RELAY_URL=wss://relay.example.com \
RELAY_TOKEN=<same token> \
WDA_URL=http://127.0.0.1:8100 \
npm run agent
```

### 3. MCP server (in the sandbox)

```json
{
  "mcpServers": {
    "iphone": {
      "command": "node",
      "args": ["/path/to/iphone-control/dist/mcp/main.js"],
      "env": {
        "IPHONE_BACKEND": "relay",
        "RELAY_URL": "wss://relay.example.com",
        "RELAY_TOKEN": "<same token>"
      }
    }
  }
}
```

`IPHONE_BACKEND` also accepts `wda` (talk to a phone on the same network,
skipping the relay) and `mock` (no hardware at all — useful for developing
against the tool surface).

## How the model is meant to use it

`describe_screen` returns the accessibility tree flattened to visible, labelled
elements with their bounding boxes and pre-computed centers:

```
Foreground app: com.apple.springboard

- Icon "Settings" center=(54, 130) rect=[24, 100, 60, 60]
- Icon "Notes" center=(134, 130) rect=[104, 100, 60, 60]
```

Coordinates come from there, not from eyeballing a screenshot. `screenshot`
exists to *see* the device; `describe_screen` exists to *act* on it. The tool
descriptions say so, because that distinction is where naive device-control
agents usually fall over.

## Security

Pairing is a shared secret. Tokens are hashed and compared with
`timingSafeEqual`, never logged, and an unrecognised token is rejected before
any routing state is created — the client is not retried after a `4003`.

A token grants full interactive control of the phone: everything a person
holding it could do, including reading messages and signed-in accounts. Treat it
like a device passcode. Run the relay over TLS only, and use a distinct token
per device pair.

## Status

The transport, protocol, relay, MCP surface, and mock device are complete and
tested end to end. The WDA backend is written against WebDriverAgent's
documented HTTP endpoints and unit-tested against a fake, but it has not been
exercised against physical hardware in this repository.
