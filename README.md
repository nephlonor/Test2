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
| `src/cli/` | Operator CLI: generate tokens, run `doctor`, drive the phone by hand. |

## Running it

Install and check:

```bash
npm install
npm test          # 31 tests, including a full end-to-end run over real sockets
npm run typecheck
npm run build
```

Requires Node 22.6+ — the test runner loads the TypeScript sources directly via
type stripping.

### 1. Relay (on a public host)

```bash
npm run cli -- token          # generate a pairing secret
RELAY_TOKENS=<token> PORT=8787 npm run relay
```

Put TLS in front of it. The relay speaks plain WebSocket and expects to sit
behind a terminating proxy. It serves `GET /healthz` on the same port for load
balancer checks.

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

### 4. Check it

`doctor` walks the chain hop by hop, so a failure names the layer that broke
rather than making you guess:

```console
$ npm run cli -- doctor
backend: relay
  ok  relay reachable (https://relay.example.com/healthz, HTTP 200)
  ok  device responded: iPhone 15 Pro, iOS 18.0
  ok  screen 393x852 pt
  ok  accessibility tree readable (37 elements)

All checks passed.
```

The same CLI drives the phone by hand — useful for shaking out WebDriverAgent
without a model in the loop:

```bash
npm run cli -- describe              # list elements with tap targets
npm run cli -- tap 196 420
npm run cli -- launch com.apple.mobilesafari
npm run cli -- screenshot out.png
```

## Staying connected

A phone on cellular drops off without closing its socket, and the relay would
otherwise keep routing commands into a connection that no longer exists. Both
directions are covered:

- The relay pings every endpoint every 30s and terminates anything that misses
  two consecutive sweeps.
- The agent runs an idle watchdog and `terminate()`s a silent relay connection
  rather than waiting on a close handshake that will never arrive, then
  reconnects with exponential backoff.
- Frames are capped (16 MB default) so an oversized screenshot cannot wedge the
  relay.

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

The transport, protocol, relay, MCP surface, CLI, and mock device are complete
and tested end to end, including heartbeat/reconnect behaviour under simulated
network loss.

The WDA backend is written against WebDriverAgent's documented HTTP endpoints
and unit-tested against a fake that reproduces its quirks (errors returned with
HTTP 200, booleans as `"1"`), but it has **not** been exercised against physical
hardware in this repository — there is no iPhone in CI. `npm run cli -- doctor`
is the first thing to run once a real device is attached.
