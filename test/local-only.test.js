'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { randomBytes } = require('crypto')
const c = require('compact-encoding')
const HyperDHT = require('hyperdht')
const m = require('hyperdht/lib/messages')
const NoiseWrap = require('hyperdht/lib/noise-wrap')
const { COMMANDS, FIREWALL } = require('hyperdht/lib/constants')
const HyperDHTmDNS = require('..')
const { localAddresses } = require('../src/lan-dht')
const MemoryAdapter = require('../test-utils/memory-adapter')
const recordSends = require('../test-utils/udx-sends')
const { createLAN, sleep } = require('../test-utils/lan-net')

// Ports 21450-21469.

// dht-rpc's FIND_NODE, and the modes of hyperdht's relayed messages.
const FIND_NODE = 2
const FROM_CLIENT = 0
const FROM_SERVER = 1
const FROM_RELAY = 2
const REPLY = 4

const outsider = { host: '203.0.113.7', port: 40000, family: 4 }

// A plain DHT node on loopback, as another machine on the network.
async function node (port) {
  const dht = HyperDHT.bootstrapper(port, '127.0.0.1', { bootstrap: [], host: '127.0.0.1' })
  await dht.fullyBootstrapped()
  return dht
}

// A FIND_NODE with a token the node never handed out. dht-rpc answers one by
// itself, with an error, a new token and nodes from its table.
function wrongToken (dht, to) {
  const req = dht.io.createRequest(to, randomBytes(32), true, FIND_NODE, randomBytes(32), null, null, 0)
  return new Promise((resolve, reject) => {
    req.retries = 0
    req.onresponse = resolve
    req.onerror = reject
    req.send()
  })
}

test('only private, link-local and (when allowed) loopback addresses are local', () => {
  const isLocal = localAddresses('192.168.1.20')
  for (const host of ['10.0.0.4', '172.16.0.1', '172.31.255.254', '192.168.1.99', '169.254.10.20', '::ffff:192.168.1.99', '::FFFF:10.0.0.4']) {
    assert.equal(isLocal(host), true, host)
  }
  for (const host of ['8.8.8.8', '172.32.0.1', '100.64.0.1', '203.0.113.7', '127.0.0.1', '::1', '::ffff:8.8.8.8', '', 'x', '1.2.3', '1.2.3.400', undefined]) {
    assert.equal(isLocal(host), false, String(host))
  }
  assert.equal(localAddresses('127.0.0.1', { allowLoopback: true })('127.0.0.1'), true)
  // A network that hands out public addresses: its own /24 only.
  const campus = localAddresses('198.51.100.20')
  assert.equal(campus('198.51.100.77'), true)
  assert.equal(campus('198.51.101.77'), false)
})

// A node elsewhere on the network that has internet nodes in its table, as a
// LAN DHT that leaked would. Its answers name one; this device must neither
// take it nor send it anything, and a request from outside goes unanswered.
test('the LAN DHT takes nothing from outside the local network and sends nothing there', async (t) => {
  const outside = { host: '203.0.113.7', port: 49737 }
  const leaky = HyperDHT.bootstrapper(21450, '127.0.0.1', { bootstrap: [] })
  await leaky.fullyBootstrapped()
  leaky.addNode(outside)
  const lan = new HyperDHTmDNS({
    host: '127.0.0.1',
    port: 21451,
    allowLoopback: true,
    adapter: new MemoryAdapter(new Set()),
    // Another DHT's sockets: not taken.
    dhtOptions: { udx: leaky.udx }
  })
  lan.on('warning', () => {})
  t.after(async () => {
    await lan.destroy()
    await leaky.destroy()
  })
  await lan.ready()

  // Bound to the one address it announces, not to every interface, on a UDX
  // of its own.
  assert.equal(lan.dht.io.serverSocket.address().host, '127.0.0.1')
  assert.equal(lan.dht.io.clientSocket.address().host, '127.0.0.1')
  assert.equal(lan.dht._socketPool._host, '127.0.0.1')
  assert.notEqual(lan.dht.udx, leaky.udx)

  lan.dht.addNode({ host: '127.0.0.1', port: 21450 })
  for await (const reply of lan.dht.findNode(randomBytes(32))) assert.ok(reply)
  assert.deepEqual(lan.dht.toArray().map((node) => node.host), ['127.0.0.1'])
  assert.ok(lan.info().stats.outsideDropped > 0, 'the leaky node did name the outside one')

  lan.dht.addNode(outside)
  assert.equal(lan.dht.toArray().some((node) => node.host === outside.host), false)
  await assert.rejects(lan.dht.ping(outside))

  let answered = false
  const dropped = lan.info().stats.outsideDropped
  lan.dht.io.onrequest({ from: { ...outside, id: randomBytes(32) }, reply () { answered = true } }, true)
  assert.equal(answered, false)
  assert.equal(lan.info().stats.outsideDropped, dropped + 1)
})

test('requests with made-up tokens count against the rate limits like any other', async (t) => {
  const lan = await createLAN(1, { basePort: 21452, limits: { requestsPerSecond: 20, requestBurst: 40 } })
  t.after(lan.destroy)
  const [a] = lan.nodes
  const b = await node(21453)
  t.after(() => b.destroy())

  // dht-rpc answers these before any handler runs, so in 2.0.0 every one
  // got an answer, with nodes from the routing table.
  const started = Date.now()
  const results = await Promise.allSettled(Array.from({ length: 300 }, () => wrongToken(b, { host: '127.0.0.1', port: a.port })))
  const allowed = 40 + Math.ceil(20 * (Date.now() - started) / 1000)
  const answered = results.filter((result) => result.status === 'fulfilled').length
  assert.ok(answered <= allowed, `${answered} answered, ${allowed} allowed`)
  assert.ok(a.dht.hyperdhtMdns.stats.droppedRequests >= 300 - allowed, `${a.dht.hyperdhtMdns.stats.droppedRequests} dropped`)
})

test('a request from outside the local network gets no answer, not even about its token', async (t) => {
  const sends = recordSends()
  t.after(() => sends.restore())
  const lan = await createLAN(1, { basePort: 21454 })
  t.after(lan.destroy)
  const [a] = lan.nodes
  const b = await node(21455)
  t.after(() => b.destroy())

  // A FIND_NODE with a made-up token, arriving from an internet address
  // that reached the port through the router.
  const req = b.io.createRequest({ host: '127.0.0.1', port: a.port }, randomBytes(32), true, FIND_NODE, randomBytes(32), null, null, 0)
  const packet = req._encodeRequest(req.token, req.value, req.to, req.socket)
  req.destroy()
  const dropped = a.info().stats.outsideDropped
  let read = 0
  a.dht.io.serverSocket.on('message', () => read++)
  a.dht.io.serverSocket.emit('message', packet, outsider)
  await sleep(100)

  // Dropped as it arrived: nothing read it, so nothing answered it.
  assert.equal(read, 0)
  assert.equal(a.info().stats.outsideDropped, dropped + 1)
  assert.deepEqual(sends.outward(a.dht), [])
})

test('a relay or hole punch reply aimed outside the local network is not sent', async (t) => {
  const sends = recordSends()
  t.after(() => sends.restore())
  const lan = await createLAN(1, { basePort: 21456 })
  t.after(lan.destroy)
  const [a] = lan.nodes
  const d = await node(21457)
  t.after(() => d.destroy())
  const to = { host: '127.0.0.1', port: a.port }
  const dropped = a.info().stats.outsideDropped

  // A handshake to pass on to a "relay" on the internet, and a hole punch
  // reply for a "peer" there: the router sends both where the message says.
  const handshake = c.encode(m.handshake, { mode: FROM_CLIENT, noise: randomBytes(48), peerAddress: null, relayAddress: { host: '203.0.113.7', port: 9 } })
  const holepunch = c.encode(m.holepunch, { mode: FROM_SERVER, id: 0, payload: randomBytes(32), peerAddress: { host: '203.0.113.8', port: 10 } })
  await Promise.allSettled([
    d.request({ command: COMMANDS.PEER_HANDSHAKE, target: randomBytes(32), value: handshake }, to, { retry: false }),
    d.request({ command: COMMANDS.PEER_HOLEPUNCH, target: randomBytes(32), value: holepunch }, to, { retry: false })
  ])

  assert.ok(a.info().stats.outsideDropped >= dropped + 2)
  assert.deepEqual(sends.outward(a.dht).map((entry) => `${entry.host}:${entry.port}`), [])
})

test('a server never connects to a client outside the local network that a relay names', async (t) => {
  const sends = recordSends()
  t.after(() => sends.restore())
  const lan = await createLAN(1, { basePort: 21458 })
  t.after(lan.destroy)
  const [a] = lan.nodes
  const relay = await node(21459)
  t.after(() => relay.destroy())

  // A note host's server on the LAN DHT, besides the swarm's own.
  const noteKeyPair = HyperDHT.keyPair()
  let connections = 0
  const server = a.dht.createServer((socket) => {
    connections++
    socket.on('error', () => {})
  })
  await server.listen(noteKeyPair)
  t.after(() => server.close())
  a.on('connection', () => connections++)

  // A client that says its firewall is open, relayed from an internet
  // address. Without the check the server connects a stream to it.
  await Promise.allSettled([a.keyPair.publicKey, noteKeyPair.publicKey].map((publicKey) => {
    const noise = new NoiseWrap(HyperDHT.keyPair(), publicKey).send({
      version: 1,
      error: 0,
      firewall: FIREWALL.OPEN,
      holepunch: null,
      addresses4: [],
      addresses6: [],
      udx: { reusableSocket: false, id: 7, seq: 0 },
      secretStream: {},
      relayThrough: null
    })
    const value = c.encode(m.handshake, { mode: FROM_RELAY, noise, peerAddress: { host: '203.0.113.9', port: 11 }, relayAddress: null })
    return relay.request({ command: COMMANDS.PEER_HANDSHAKE, target: HyperDHT.hash(publicKey), value }, { host: '127.0.0.1', port: a.port }, { retry: false })
  }))
  await sleep(300)

  assert.equal(connections, 0)
  assert.equal(a.dht.rawStreams.size, 0)
  assert.ok(a.info().stats.outsideDropped >= 2)
  assert.deepEqual(sends.outward(a.dht), [])
})

test('a client never connects to a server at an address outside the local network', async (t) => {
  const sends = recordSends()
  t.after(() => sends.restore())
  const lan = await createLAN(1, { basePort: 21460 })
  t.after(lan.destroy)
  const [a] = lan.nodes
  const relay = await node(21461)
  t.after(() => relay.destroy())

  // A node that answers a handshake as the server's relay, with the server's
  // reply, and says where the server is. The server says its firewall is
  // open, so the client goes straight to the address it is given.
  const keyPair = HyperDHT.keyPair()
  const answer = ({ serverAddress, addresses4 }) => {
    relay._router.onpeerhandshake = (req) => {
      const handshake = new NoiseWrap(keyPair, null)
      handshake.recv(c.decode(m.handshake, req.value).noise)
      const noise = handshake.send({
        version: 1,
        error: 0,
        firewall: FIREWALL.OPEN,
        holepunch: null,
        addresses4,
        addresses6: [],
        udx: { reusableSocket: false, id: 1, seq: 0 },
        secretStream: {},
        relayThrough: null
      })
      req.reply(c.encode(m.handshake, { mode: REPLY, noise, peerAddress: serverAddress }), { closerNodes: false, token: false })
    }
  }
  const via = { relayAddresses: [{ host: '127.0.0.1', port: relay.port }] }

  // The relay says the server is on the internet: the attempt ends there,
  // before the handshake is done.
  answer({ serverAddress: { host: '203.0.113.11', port: 13 }, addresses4: [] })
  let dropped = a.info().stats.outsideDropped
  const socket = a.dht.connect(keyPair.publicKey, via)
  let connected = false
  socket.on('connect', () => { connected = true })
  socket.on('error', () => {})
  await new Promise((resolve) => socket.on('close', resolve))
  assert.equal(connected, false)
  assert.ok(a.info().stats.outsideDropped > dropped)

  // The server lists an address on the internet for itself as well: it is
  // reached at its local one.
  answer({ serverAddress: { host: '127.0.0.1', port: 21464 }, addresses4: [{ host: '203.0.113.12', port: 14 }] })
  dropped = a.info().stats.outsideDropped
  const local = a.dht.connect(keyPair.publicKey, via)
  local.on('error', () => {})
  await new Promise((resolve, reject) => {
    local.once('connect', resolve)
    local.once('close', () => reject(new Error('Closed before it connected')))
  })
  assert.equal(`${local.rawStream.remoteHost}:${local.rawStream.remotePort}`, '127.0.0.1:21464')
  assert.ok(a.info().stats.outsideDropped > dropped)
  local.destroy()

  // A stream asked to go outside directly is refused too.
  const stream = a.dht.createRawStream()
  const closed = new Promise((resolve) => stream.on('close', resolve))
  stream.on('error', () => {})
  stream.connect(a.dht.io.serverSocket, 1, 13, '203.0.113.11')
  assert.equal(stream.connected, false)
  await closed
  assert.deepEqual(sends.outward(a.dht), [])
})

test('a stream takes no packet from outside the local network and is never moved there', async (t) => {
  const lan = await createLAN(1, { basePort: 21468 })
  t.after(lan.destroy)
  const [a] = lan.nodes
  const socket = a.dht.io.serverSocket
  const dropped = a.info().stats.outsideDropped

  // Stream packets are sorted out natively, past the socket checks. One from
  // an address the stream is not connected to goes to its firewall, where
  // hyperdht would connect the stream to that address.
  const asked = []
  const waiting = a.dht.createRawStream({
    firewall (from, port, host) {
      asked.push(host)
      return false
    }
  })
  assert.equal(waiting._onfirewall(socket, 11, '203.0.113.9', 4), 1)
  assert.equal(waiting._onfirewall(socket, 11, '127.0.0.1', 4), 0)
  assert.deepEqual(asked, ['127.0.0.1'])
  waiting.destroy()

  // A connected stream asked to move outside, as a hole punch would, is
  // refused and closed, and stays where it was.
  const moving = a.dht.createRawStream()
  moving.on('error', () => {})
  const closed = new Promise((resolve) => moving.on('close', resolve))
  moving.connect(socket, 1, 21469, '127.0.0.1')
  await assert.rejects(moving.changeRemote(socket, 1, 13, '203.0.113.11'))
  await closed
  assert.equal(`${moving.remoteHost}:${moving.remotePort}`, '127.0.0.1:21469')
  assert.equal(a.info().stats.outsideDropped, dropped + 2)
})

test('delayed pings are not taken, so nobody can make the node hold timers for them', async (t) => {
  const lan = await createLAN(1, { basePort: 21462 })
  t.after(lan.destroy)
  const [a] = lan.nodes
  const e = await node(21463)
  t.after(() => e.destroy())

  const dropped = a.dht.hyperdhtMdns.stats.droppedRequests
  const pings = Array.from({ length: 4 }, () => e.delayedPing({ host: '127.0.0.1', port: a.port }, 200, { retry: false }))
  await sleep(100)
  assert.equal(a.dht._pendingTimers.size, 0)
  for (const ping of pings) await assert.rejects(ping)
  assert.equal(a.dht.hyperdhtMdns.stats.droppedRequests, dropped + 4)
})

test('the sockets made again after a suspend and resume are checked too', async (t) => {
  const sends = recordSends()
  t.after(() => sends.restore())
  const lan = await createLAN(1, { basePort: 21466 })
  t.after(lan.destroy)
  const [a] = lan.nodes
  const before = a.dht.io.serverSocket
  await a.suspend()
  await a.resume()
  assert.notEqual(a.dht.io.serverSocket, before)

  const dropped = a.info().stats.outsideDropped
  let read = 0
  a.dht.io.serverSocket.on('message', () => read++)
  a.dht.io.serverSocket.emit('message', Buffer.from([0x03, 0, 0]), outsider)
  a.dht.io.serverSocket.trySend(Buffer.alloc(1), outsider.port, outsider.host)
  assert.equal(read, 0)
  assert.equal(a.info().stats.outsideDropped, dropped + 2)
  assert.deepEqual(sends.outward(a.dht), [])
})
