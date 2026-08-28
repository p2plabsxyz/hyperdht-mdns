# hyperdht-mdns

Offline LAN discovery for Hyperswarm using zero-install mDNS and an isolated
HyperDHT.

Experimental offline LAN discovery for Hyperswarm and Corestore applications.
Each process runs a separate, bootstrap-free HyperDHT and advertises one or more
mDNS services (`_hyperdht-mdns._udp`). mDNS exchanges node endpoints and hashed
topic tokens. Nodes make one authenticated, encrypted connection only when they
share a joined topic; Corestore multiplexes shared cores over that stream.
Isolated Hyperswarm topic joins also remain active for normal DHT discovery as
the LAN grows.

## Install

```sh
npm install @p2plabs/hyperdht-mdns
```

## Usage

```js
const Corestore = require('corestore')
const HyperDHTmDNS = require('@p2plabs/hyperdht-mdns')

const store = new Corestore('./userData/hyper')
const lan = new HyperDHTmDNS({ port: 49799 })

lan.on('connection', (socket) => store.replicate(socket))
lan.on('warning', console.warn)

await store.ready()
await lan.ready()

const core = store.get({ name: 'messages' })
await core.ready()
lan.join(core.discoveryKey)
```

### hyper-sdk

Attach LAN discovery to an existing SDK. This reuses its network key pair,
mirrors joins and leaves, forwards LAN connections through the existing swarm
event, and includes LAN shutdown in the SDK lifecycle:

```js
import { create as createSDK } from 'hyper-sdk'
import HyperDHTmDNS from '@p2plabs/hyperdht-mdns'

const sdk = await createSDK({ storage: './userData/hyper' })
await HyperDHTmDNS.attachHyperSDK(sdk, { port: 49799 })

sdk.join(roomTopic)

// Optional: connectivity monitor can disable only the public swarm.
await sdk.setLANOnly(true)
await sdk.setLANOnly(false) // internet is reachable again
```

The bridge makes `sdk.swarm.flush()` LAN-first: public DHT flushing continues in
the background, so loss of internet access does not block a local room join.

To manage global and LAN discovery manually, reuse the same network key pair
and join both swarms:

```js
const HyperDHT = require('hyperdht')
const Hyperswarm = require('hyperswarm')
const HyperDHTmDNS = require('@p2plabs/hyperdht-mdns')

const keyPair = HyperDHT.keyPair()
const globalSwarm = new Hyperswarm({ keyPair })
const lanSwarm = new HyperDHTmDNS({ keyPair, port: 49799 })

globalSwarm.on('connection', replicate)
lanSwarm.on('connection', replicate)

globalSwarm.join(topic)
lanSwarm.join(topic)
```

## API

### `const lan = new HyperDHTmDNS([options])`

- `port`: fixed UDP firewall port. Defaults to `49799`.
- `host`: local IPv4 address to advertise as the DHT address. By default the
  module selects a private, non-loopback interface.
- `keyPair`: HyperDHT key pair. Reuse the global swarm key pair when applicable.
- `eager`: enable a direct connection for matching topics. Defaults to `true`.
  This is required for reliable two-node DHT networks.
- `dhtOptions` and `swarmOptions`: additional constructor options.
- `adapter`: custom mDNS adapter implementing only `advertise()` and `browse()`.
  The default is `BonjourAdapter`, backed by the zero-install, pure-JavaScript
  `bonjour-service` package. Mobile applications can inject a system Bonjour or
  Android NSD implementation without changing any HyperDHT logic.

The instance owns its DHT and swarm by default. Supplying `swarm` (and optionally
`dht`) is intended for advanced adapters and leaves unmatched connections alone.
An owned DHT is bound to the selected `host`; after Wi-Fi, cellular, or sleep/wake
interface changes, destroy and recreate the instance before resuming discovery.

An adapter has this shape; either method may also return its handle in a
Promise:

```js
const adapter = {
  advertise (record, { onError }) {
    return { stop: async () => {} }
  },
  browse ({ type, protocol }, { onService, onServiceDown, onError }) {
    return { stop: async () => {} }
  }
}
```

The module owns record refreshes: it stops the old advertisement and calls
`advertise()` again when joined topics change. A custom backend only needs to
publish records, report discovered services, and stop its returned handles.

The instance exposes `ready()`, `join()`, `leave()`, `joinPeer()`, `leavePeer()`,
`listen()`, `flush()`, `topics()`, `suspend()`, `resume()`, and `destroy()`. It
emits `connection`, `topics-change`, `peer`, `peer-reachable`, `peer-down`,
`warning`, `error`, `ready`, and `close` events.

Matching peers are reconnected automatically after transient socket loss using
bounded exponential backoff. Retries stop when the discovery adapter reports
the peer down, the last shared topic is left, or the instance is suspended or
destroyed.

## mDNS record

One service is normally published per process:

```json
{
  "v": "1",
  "peerKey": "<64-hex-hyperswarm-public-key>",
  "port": "49799",
  "tc": "1",
  "t0": "<base64url-sha256-topic-token>"
}
```

Each token is `SHA256("hyperdht-mdns:" + topic)` encoded as unpadded base64url.
Raw discovery keys are never advertised. TXT values are chunked below the DNS
255-byte string limit, and each TXT payload is capped at 900 bytes to avoid
fragmented multicast packets on typical Wi-Fi networks. When every joined topic
does not fit in one payload, the module publishes additional bounded service
records. Their service names identify the generation and shard, allowing peers
to aggregate the complete topic set without silently dropping older topics.

Two-node DHTs have a storage symmetry problem: each node stores its announcement
on the other node, then queries that other node and sees only its own record.
The direct matching connection uses the advertised endpoint as HyperDHT's relay
address, preserving its authenticated Noise/UDX transport without waiting for a
third routing node. Nodes with no shared topic do not connect.

## Network requirements

- Allow inbound and outbound UDP on the configured DHT port.
- Allow mDNS multicast on UDP `5353` (`224.0.0.251`).
- Peers must be on a multicast-capable IPv4 LAN. Guest Wi-Fi networks commonly
  enable client isolation and will prevent both discovery and direct traffic.
- Run one instance per UDP port on a device. Configure another fixed port when
  running multiple processes on the same host.
- A port conflict reports the configured port; choose a different fixed port
  before starting another local instance.
- If multiple IPv4 interfaces are active (for example VPN, Docker, Ethernet, and
  Wi-Fi), pass `host` explicitly. The automatic selection prefers `192.168.*` over
  `10.*` over `172.16-31.*`; a corporate VPN on `10.*` can win over the actual
  local network. The DHT binds one interface while mDNS may advertise on several,
  so peers on other subnets will discover the node but fail to reach its DHT.

The current default mDNS implementation is pure JavaScript and uses socket
reuse on port 5353. The adapter boundary exists because native system-daemon
bindings remain platform-dependent.

To smoke-test the real default adapter with two local DHT nodes before using
physical computers, run `npm run test:mdns`.

## Three-computer offline test

Before integrating the module into an application, use the standalone CLI to
verify that HyperDHT works with LAN-only addresses. Install dependencies on
three Windows, macOS, or Linux computers connected to the same
multicast-capable LAN, then disconnect or block internet access and run:

```sh
npm run demo:lan -- --name windows --room test-room
npm run demo:lan -- --name mac --room test-room
npm run demo:lan -- --name linux --room test-room
```

Run one command on each computer, using the same room and a different name. The
output on every computer must show:

- `bootstrap nodes: 0`;
- the other two mDNS records as discovered and reachable;
- two authenticated HyperDHT connections; and
- messages entered on any computer arriving on the other two.

After the first successful exchange, interrupt one machine's LAN connection and
restore it without restarting the CLI. The peers should reconnect and exchange
messages again. Repeat the interruption once more to cover consecutive recovery
cycles.

Allow UDP `5353` and `49799` through each firewall. If a computer has multiple
network interfaces, pass its LAN address with `--host`. Use `--port` only when
the default DHT port is unavailable.
