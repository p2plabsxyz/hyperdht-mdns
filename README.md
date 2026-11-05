<p align="center">
    <picture>
        <source media="(prefers-color-scheme: dark)" srcset="assets/hyperdht-mdns-dark.svg">
        <source media="(prefers-color-scheme: light)" srcset="assets/hyperdht-mdns.svg">
        <img src="assets/hyperdht-mdns.svg" width="120" height="120" alt="">
    </picture>
</p>

<h1 align="center">hyperdht-mdns</h1>

Private, scalable LAN peer discovery for Hyperswarm: an isolated HyperDHT on
the local network, seeded by mDNS.

Each process runs its own HyperDHT with no bootstrap nodes. mDNS only tells
devices where a few neighbours are. From there the LAN DHT works the way the
internet DHT does: topics are announced and looked up, and devices that share
a topic connect over HyperDHT's encrypted Noise/UDX transport. Corestore
replicates over those connections as usual.

Three goals shape version 2:

- **The network tells as little as it can about who you are and what you are in.**
- **It works with thousands of devices on one network.**
- **One hostile device cannot take it down.**

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

Attach LAN discovery to an existing SDK. Joins and leaves are mirrored on the
LAN, LAN connections arrive on the SDK swarm's `connection` event, and the LAN
instance is closed with the SDK:

```js
import { create as createSDK } from 'hyper-sdk'
import HyperDHTmDNS from '@p2plabs/hyperdht-mdns'

const sdk = await createSDK({ storage: './userData/hyper' })
await HyperDHTmDNS.attachHyperSDK(sdk, { port: 49799 })

sdk.join(roomTopic)

// Optional: a connectivity monitor can turn off only the internet swarm.
await sdk.setLANOnly(true)
await sdk.setLANOnly(false) // the internet is back
```

The LAN instance gets a key pair of its own, made up for this run, never the
SDK's (see [Privacy](#privacy)). Connections from the LAN arrive with
`info.lan` and `info.ephemeral` set.

What goes out on the LAN:

- topics joined with `sdk.join`, such as rooms and private sync, as asked;
- drives this device writes, announced as asked;
- drives opened only to read are looked up, not announced. Their LAN lookup
  ends once the drive has not been opened for `coreTopicTTL` (10 minutes by
  default) and starts again the next time it is opened. hypercore-fetch opens
  a drive on every request, so a drive in use stays on the LAN. The internet
  lookup does not change.

A lookup carries its topic just as an announcement does. See
[Privacy](#privacy) for who can see it.

`sdk.swarm.flush()` is LAN first: the internet flush goes on in the
background, so no internet does not block a local join.

To run the internet and LAN swarms yourself, give each its own key pair and
join both:

```js
const Hyperswarm = require('hyperswarm')
const HyperDHTmDNS = require('@p2plabs/hyperdht-mdns')

const globalSwarm = new Hyperswarm()
const lanSwarm = new HyperDHTmDNS({ port: 49799 })

globalSwarm.on('connection', replicate)
lanSwarm.on('connection', replicate)

globalSwarm.join(topic)
lanSwarm.join(topic)
```

## Privacy

On a shared Wi-Fi network anyone can listen to mDNS and talk to the LAN DHT.
Version 2 is built so that they learn as little as possible.

1. **mDNS says nothing personal.** A device's mDNS records say only that a
   device of this kind is at this address and port, under a random name made
   up for this run. No device key, no topics, no machine hostname (a computer
   is often named after its owner), no other interfaces such as a VPN or
   Docker network, and no IPv6 addresses.
2. **Topics go on the LAN DHT, and its nodes see them.** Topics are announced
   and looked up on the LAN DHT, as on the internet. Each lookup and each
   announcement carries the 32-byte topic unencrypted to the DHT nodes it
   asks, and on a small network that is every node, a hostile one included.
   So anyone who runs a LAN DHT node can see which topics are asked for and
   announced, the per-run keys and LAN addresses announced under them, and
   who shares a topic with whom. It can also look a topic up itself. What
   it cannot do is tell which room or drive a topic belongs to, unless it
   already knows that topic. The LAN DHT talks to local addresses only, so
   none of this leaves the network.
3. **Connections use a key that changes every run.** On the internet a
   device's swarm key is often also its identity in apps (in PeerChat it is
   your id), so it would follow you from network to network. On the LAN each
   instance connects with a fresh key pair. Who you are is proven only inside
   the encrypted channel, and only to peers that share a secret with you, such
   as another member of the same room or another of your own devices (see
   [Proving who you are](#proving-who-you-are)). So the LAN key does not link
   people on a shared network, such as a protest network, across days and
   places. A topic that stays the same still can (see 2).
4. **Keep private groups on secret topics, and rotate them if that
   matters.** A topic anyone can learn, such as a public room's, lets anyone
   who joins find its members, on the LAN as on the internet. A secret topic
   cannot be found by someone who does not know it, but it is still seen by
   the LAN DHT nodes it passes through, and it is the same on every network.
   A topic that is also joined on the internet, as `attachHyperSDK` does,
   can be looked up there by anyone who saw it on the LAN. That lookup gives
   the long-term keys announced under it, which can then be matched to the
   LAN addresses announcing it. An app that needs more can change its topics
   over time, for example by making each one from the room key and the date,
   so a topic seen today says nothing next week.

Pass `keyPair` or `seed` only when you want a fixed LAN key; `lan.ephemeral`
then reads `false`.

## Proving who you are

The LAN key says nothing about who is on the other end. When an app needs to
know, both sides run `identityGate` on the connection:

```js
const { identityGate } = require('@p2plabs/hyperdht-mdns')

lan.on('connection', async (socket, info) => {
  const result = await identityGate(socket, {
    keyPair: identityKeyPair, // the long-term key pair
    secrets: [roomKey, devicesKey], // 16 to 64 bytes each
    context: 'my-app',
    // Optional: whether to go on with this key, such as a room's member list.
    accept: (publicKey, matches) => members.has(publicKey.toString('hex'))
  })
  if (!result) return // nothing shared, or one side said no
  // result.publicKey is their long-term key, proven for this connection.
  // result.matches lists the indexes of the secrets you share.
})
```

Each side sends one token per secret, made from the secret and this
connection, padded with random tokens to a multiple of 16. A token means
nothing to someone without the secret and nothing on any other connection. A
list of more than 512 tokens is not read: it closes the gate, and the
connection is left alone.

The long-term keys are proven in a fixed order. The side that opened the
connection proves first, once it has matched one of the other side's tokens.
The other side proves only after that proof checked out and `accept` said yes.
So someone who holds a shared secret but declines, or whom `accept` turns
down, learns nothing from the side that proves second. The side that proves
first does prove itself to anyone who holds a secret it shares: keep secrets
to the people meant to have them, and use `accept` to check who they are.
A proof is a signature over this connection's handshake hash and both
connection keys, so it cannot be replayed elsewhere.

The gate returns `null` when nothing is shared, the other side declines or
does not run it, `accept` says no, or after `timeout` (15 seconds). `accept`
gets the other side's proven key and the indexes of the matched secrets, and
may return a promise; only `true` goes on.

`createIdentityProof(keyPair, connection, context)` and
`verifyIdentityProof(proof, connection, context)` are the proof alone, for
apps that already know whom to tell.

## Scale

Nothing a device does grows with the number of devices on the network:

- **mDNS only seeds.** A device keeps at most `maxDevices` (256) mDNS
  sightings and pings at most `maxSeeds` (32) of them into its DHT routing
  table. After that the LAN DHT takes over: each device knows a few dozen
  others, and lookups take a few hops.
- **mDNS traffic stays small.** Each device announces itself when it starts,
  again a second later, and then every 2 minutes on a jittered timer, with a
  5 minute TTL and a goodbye when it stops. Queries are answered by about 32
  devices, not all of them, at most once every 5 seconds per asker, and not
  at all by devices the asker already lists. A device answers about once a
  second at most, whoever asks, since an asker's address is easy to forge.
  An answer goes to the whole network, so one on its way serves everyone who
  asks in the meantime, and it carries each record once.
- **Connections are capped,** like the internet swarm: at most `maxPeers` (64)
  in both directions, and this device dials no one once it has
  `outgoingPeers` (40), so there is always room for a newcomer. Peers dialled
  per topic are an even share of that, between 2 and `peersPerTopic` (8), so a
  big room cannot take every connection from the small ones. There is no full
  mesh: apps that pass messages on, as PeerChat does, reach everyone anyway.
- **Announcing is batched and spread out.** Joins go out in batches, at most
  `joinsPerBatch` (8) new topics every `batchInterval` (2 seconds); a lone join
  goes out at once. Refreshes run on jittered timers and are rate limited, not
  set off by every device that shows up.

`npm run test:stress` runs hundreds of devices in worker processes on one
computer, with the parent process as the multicast network. A run with 300
devices, 10 workers and 9 rooms, on one Mac:

| Phase | Result |
| --- | --- |
| Start | every device had a routing table within 2 seconds (about 96 nodes each later on), at most 32 seeds and 256 sightings |
| Rooms | one room of 300 and eight of 28 to 44: a message reached every member of every room (the room of 300 in 58 ms at the 95th percentile), at most 64 connections per device (44 on average) |
| Left without a goodbye | 30 devices gone: no stale entries left anywhere, messages still reached everyone left |
| Airplane mode | 30 devices away while messages were sent: back on new keys, all 42 missed messages caught up within 2 seconds |
| One hostile machine | 60 DHT nodes on one address, thousands of made-up mDNS devices, request and announce floods, and 8160 requests with made-up tokens at one device, which answered 1548 of them, within its limit for one machine: messages still reached every honest device, latecomers still joined, at most 4 hostile entries in any table |

300 devices is about what one computer can run. The per-device numbers stay
flat as the network grows, which is what lets it go to thousands.

## A hostile device

One machine on the network can lie, flood and pretend to be many devices.
Every table is bounded and every source of work is rate limited:

- **The LAN stays on the LAN.** The LAN DHT answers, adds and contacts only
  local addresses: private ranges (`10/8`, `172.16/12`, `192.168/16`) and
  link-local (`169.254/16`), or the bound address's own `/24` on a network
  that hands out public addresses. A packet from anywhere else is dropped as
  it arrives, and nothing is sent anywhere else: no reply, no relay or hole
  punch that a message asks for, and no connection, whichever address a
  peer or a relay names. Without this, an internet DHT node that reached the
  LAN port through the router's UDP mapping would add it, and the LAN DHT
  would join the internet DHT, with this network's announcements.
- **Bounded tables.** At most `maxDevices` (256) mDNS sightings, at most
  `devicesPerIP` (4) device names per IP address, and at most `nodesPerIP` (4)
  routing table entries per IP address, so one machine cannot fill your view
  of the network. The LAN DHT keeps at most `records` (8192) announcements.
- **A device that answers keeps its place.** The address an mDNS packet
  comes from is easy to forge, so one machine can make up devices from many
  addresses. A full list makes room by dropping a device that has not
  answered a ping: one whose pings failed first, otherwise one not asked yet,
  at random from the address with the most names. A device that answers is
  never pushed out, and devices not asked yet are pinged before those that
  failed are asked again, so a real newcomer still becomes a seed. A new port
  seen for a device that answers is tried only once the old one stops
  answering.
- **Gone devices drop out.** A device not heard from for `deviceTTL` (6
  minutes) leaves the list. One that still answers pings stays, so an idle
  device keeps its place and its open connections. A goodbye counts only from
  the device's own address, and since that can be forged too, a device that
  answers pings is pinged again once `goodbyeWait` (5 seconds) has passed and
  let go only if it no longer answers.
- **Rate limits.** mDNS sightings per sender (`sightingBurst`, then
  `sightingsPerSecond`), DHT requests per sender and overall, announcements
  per sender and per sender and topic (so one machine cannot drown a topic in
  fake peers), pings, refreshes and lookups. DHT requests are counted as each
  packet arrives, before the DHT reads it, so one with a made-up token counts
  too, and delayed pings, which nothing here sends, are dropped. mDNS
  answers are limited per asker and for the device as a whole. Connections
  per IP address are capped at `connectionsPerIP` (4), and refused in the
  handshake without a ban, so the same peer can come back later.
- **Identity token lists are capped.** The identity gate reads at most 512
  tokens; a longer list closes it unread.
- **Silent connections are closed.** A connection that hears nothing for
  `connectionTimeout` (15 seconds), not even keepalives, is closed and its
  slot freed.
- **The internet stays.** With hyper-sdk the internet swarm runs alongside the
  LAN, so a device with internet keeps it even if the LAN is flooded.
- **App checks do not change.** Anything a peer says still has to pass the
  app's own checks, such as signatures and room proofs.

## API

### `const lan = new HyperDHTmDNS([options])`

- `port`: the LAN DHT's fixed UDP port. Defaults to `49799`.
- `host`: the local IPv4 address to bind and announce. The LAN DHT listens on
  this address only, not on every interface. By default a private,
  non-loopback interface is chosen.
- `keyPair` or `seed`: a fixed LAN key. By default a new one every run.
- `limits`: overrides for any of `HyperDHTmDNS.DEFAULT_LIMITS` (below).
- `adapter`: a custom mDNS adapter (see [Adapters](#adapters)). The default is
  `MDNSAdapter`, on the pure JavaScript `multicast-dns` package.
- `mdnsOptions`: options for the default adapter, such as `interface`, or
  `createMDNS` to build the `multicast-dns` instance yourself.
- `hostKey(address)`: what counts as one machine for the per-IP limits. The
  address by default.
- `allowLoopback`: allow `127.0.0.1`, for tests.
- `dhtOptions` and `swarmOptions`: passed to HyperDHT and Hyperswarm.
  `dhtOptions.udx` is ignored: the LAN DHT has a UDX of its own, so its
  checks on local addresses touch no other DHT's sockets.
- `swarm` and `dht`: bring your own. The instance then leaves connections it
  did not make alone and does not apply the connection caps. A DHT you bring,
  or the one in a swarm you bring, gets none of the LAN DHT's checks either:
  not the local-only rule, the rate limits or the per-IP limits.

An owned DHT is bound to one address. After the device moves to another
network, destroy the instance and create a new one. When the instance chose
the address itself and it has changed, `resume()` throws
`ERR_LAN_INTERFACE_CHANGED`. When the DHT cannot listen on its address and
port again, as while the Wi-Fi is off, `resume()` throws
`ERR_LAN_ADDRESS_UNAVAILABLE` and the instance stays suspended: resume again
once the address is back, or create a new instance.

### Methods

- `ready()`, `listen()`: resolve once the DHT is up and mDNS is running.
- `join(topic, { server, client, limit })`: join a 32-byte topic. Returns a
  session with `refresh()`, `flushed()` and `destroy()`, usable at once.
- `leave(topic)`, `joinPeer(publicKey)`, `leavePeer(publicKey)`, `flush()`,
  `topics()`, `status(topic)`: as in Hyperswarm.
- `findPeer(publicKey, { timeout })`: where on the LAN a server with this key
  can be reached, `{ host, port }`, or `null` after `timeout` (3 seconds). For
  servers listening on the LAN DHT directly, such as one made with
  `lan.dht.createServer()`.
- `info()`: counts of devices, seeds, DHT nodes, connections and topics, and
  `stats` with what was dropped or refused.
- `suspend()`, `resume()`, `destroy()`.

Properties: `keyPair`, `ephemeral`, `host`, `port`, `name` (the random mDNS
name), `dht`, `swarm`, `connections`, `peers`, `limits`, `stats`.

### Events

- `connection (socket, info)`: `info` has `publicKey` (the other side's LAN
  key), `topics`, `client`, `relayAddresses`, `lan: true` and
  `ephemeral: true`.
- `peer ({ name, host, port })`: a device seen over mDNS.
- `peer-reachable ({ name, host, port })`: it answered a ping and seeds the DHT.
- `peer-down ({ name, ... })`: it said goodbye or went quiet. A device that
  answered pings is let go only once it stops answering.
- `warning (error)`, `error (error)`, `ready`, `update`, `close`.

### Limits

| Limit | Default | What it bounds |
| --- | --- | --- |
| `maxPeers` | 64 | connections, both directions |
| `outgoingPeers` | 40 | connections this device dials |
| `peersPerTopic` | 8 | peers dialled per topic, at most |
| `connectionsPerIP` | 4 | connections from one IP address |
| `connectionTimeout` | 15 s | silence before a connection is closed |
| `maxDevices` | 256 | mDNS sightings kept |
| `devicesPerIP` | 4 | device names from one IP address |
| `deviceTTL` | 6 min | quiet time before a device drops out |
| `sightingsPerSecond`, `sightingBurst` | 0.5, 16 | mDNS sightings per sender |
| `maxSeeds` | 32 | devices pinged into the routing table |
| `pingsPerSecond`, `pingInterval` | 10, 30 s | pings, and the wait before pinging a device again |
| `goodbyeWait` | 5 s | wait before a device that answered pings and said goodbye is pinged to check |
| `nodesPerIP` | 4 | routing table entries from one IP address |
| `requestsPerSecond`, `requestBurst` | 50, 200 | DHT requests per sender |
| `requestsPerSecondTotal` | 2000 | DHT requests overall |
| `announcesPerSecond`, `announceBurst` | 0.5, 128 | announcements per sender |
| `announcesPerTopic`, `topicAnnounceInterval` | 4, 300 s | announcements per sender and topic |
| `records` | 8192 | announcements stored |
| `batchInterval`, `joinsPerBatch` | 2 s, 8 | how topic changes are batched |
| `refreshCooldown`, `refreshesPerSecond` | 15 s, 4 | refreshes while the network grows |
| `followUps` | 1 s, 5 s | lookups after a join, for a device that joined at the same moment |
| `sweepInterval` | 15 s | how often gone devices are looked for |

## mDNS record

Each instance publishes one service, `_hyperdht-mdns._udp.local`:

- PTR: `<name>._hyperdht-mdns._udp.local`, where `<name>` is 16 random
  lowercase letters and digits, new every run;
- SRV: the LAN DHT port and `<name>.local`;
- TXT: `v=2`, and nothing else;
- A: the one IPv4 address the DHT is bound to.

`createRecord({ port })` and `parseRecord(service)` build and read it. Records
of version 1, which carried the device key and topic hashes, are ignored.

## Adapters

The default `MDNSAdapter` runs on Node, and on Bare when `mdnsOptions.createMDNS`
gives it a socket with the multicast calls. A platform can supply its own
adapter instead, such as Android NSD or Apple's Bonjour:

```js
const adapter = {
  // Set when every sighting of a device is reported, not only the first:
  // devices then drop out when their announcements stop.
  liveness: true,
  // Optional: how many devices the module knows of.
  setPopulation (count) {},
  advertise (record, { onError }) {
    // record: { name, type, protocol, port, txt, address }
    return { stop: async () => {} }
  },
  browse ({ type, protocol }, { onService, onServiceDown, onError }) {
    // onService({ name, port, txt, addresses, referer })
    return {
      query () {}, // optional: ask the network again
      stop: async () => {}
    }
  }
}
```

Either method may return its handle in a Promise.

## Migrating from 1.x

- Version 1 and version 2 devices do not see each other on the LAN. They still
  meet over the internet DHT.
- In version 1 the LAN DHT could join the internet DHT: once a packet from its
  port crossed the router, internet nodes reached it through the router's UDP
  mapping and it took them into its routing table, so LAN announcements went
  to the internet too. Version 2 keeps the LAN DHT to local addresses.
- The LAN key is new every run unless you pass `keyPair`. Code that used
  `socket.remotePublicKey` on a LAN connection as the other side's identity
  must ask with `identityGate` instead; `info.ephemeral` tells the two apart.
- `peer`, `peer-reachable` and `peer-down` carry a name, host and port, no key
  or topics.
- `attachHyperSDK` no longer uses the SDK's key pair, and drives opened only
  to read are looked up on the LAN, not announced.
- The default adapter is `MDNSAdapter` on `multicast-dns`; `BonjourAdapter`
  still works as another name for it, and `bonjour-service` is no longer a
  dependency. Custom adapters keep the same shape and receive the bound
  address in `record.address`.
- `eager` is gone. Two devices find each other through the DHT, as each answers
  lookups for the topics it announces.
- Joins go out in batches, at most one `batchInterval` later.

## Network requirements

- Allow inbound and outbound UDP on the LAN DHT port.
- Allow mDNS multicast on UDP `5353` (`224.0.0.251`).
- Devices must share a multicast-capable IPv4 network. Guest Wi-Fi often has
  client isolation, which blocks both discovery and direct traffic.
- Run one instance per UDP port on a device; give another process its own
  port. A port conflict reports the port.
- With several IPv4 interfaces (VPN, Docker, Ethernet, Wi-Fi), pass `host`.
  The automatic choice prefers `192.168.*`, then `10.*`, then `172.16-31.*`,
  so a corporate VPN on `10.*` can win over the local network.

## Tests

```sh
npm test            # unit and integration tests
npm run test:mdns   # two instances over real multicast on this computer
npm run test:stress -- --devices 300 --workers 10
```

The integration tests cover devices on the LAN that move to the internet and
back, airplane mode cycles with new keys, catching up on missed data, a
hostile machine, floods (made-up tokens and forged mDNS addresses too), and
that nothing reaches the LAN DHT from outside the local network or goes out
to it. `test:mdns` also checks what went out over multicast: a random name,
the port, the address and `v=2`, nothing more, and that the routing tables
hold local nodes only.
`docker compose up` starts four containers on the host network that must all
find each other, and `.github/workflows/benchmark-ci.yml` measures throughput
and latency with `test/benchmark.js`.

## Three-computer offline test

Before using the module in an app, check that it works with LAN-only
addresses. Install dependencies on three Windows, macOS or Linux computers on
the same multicast-capable LAN, disconnect or block internet access, and run:

```sh
npm run demo:lan -- --name windows --room test-room
npm run demo:lan -- --name mac --room test-room
npm run demo:lan -- --name linux --room test-room
```

Run one command on each computer, with the same room and a different name.
Every computer must show:

- `bootstrap nodes: 0`;
- the other two devices as discovered and reachable;
- two connections; and
- messages typed on any computer arriving on the other two.

Then cut one machine's LAN connection and restore it without restarting the
CLI. The peers should reconnect and exchange messages again. Repeat once more
to cover consecutive recovery cycles.

Allow UDP `5353` and `49799` through each firewall. If a computer has several
network interfaces, pass its LAN address with `--host`. Use `--port` only when
the default DHT port is taken.
