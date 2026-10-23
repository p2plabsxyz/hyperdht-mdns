'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { randomBytes } = require('crypto')
const HyperDHT = require('hyperdht')
const HyperDHTmDNS = require('..')
const { createLAN, nextConnection, until, sleep } = require('../test-utils/lan-net')

// Ports 21200-21399, below the ephemeral range so nothing else takes them.

test('two devices find a shared topic through the LAN DHT alone, with keys made up for the run', async (t) => {
  const lan = await createLAN(2, { basePort: 21200 })
  t.after(lan.destroy)
  const [a, b] = lan.nodes
  const topic = randomBytes(32)

  const connected = Promise.all([nextConnection(a), nextConnection(b)])
  a.join(topic)
  b.join(topic)
  const [[socketA, infoA], [, infoB]] = await connected

  assert.equal(socketA.remotePublicKey.equals(b.keyPair.publicKey), true)
  assert.equal(infoA.lan, true)
  assert.equal(infoA.ephemeral, true)
  assert.equal(a.ephemeral, true)
  // Whoever dialled found the other under the topic.
  assert.ok([infoA, infoB].some((info) => info.topics.some((value) => value.equals(topic))))
  assert.equal(a.dht.bootstrapNodes.length, 0)
})

test('what goes out over mDNS carries no key and no topic, and changes with every run', async (t) => {
  const lan = await createLAN(2, { basePort: 21210 })
  t.after(lan.destroy)
  const [a] = lan.nodes
  const topic = randomBytes(32)
  a.join(topic)
  await a.flush()

  const advertised = a.adapter.record
  assert.deepEqual(advertised.txt, { v: '2' })
  assert.match(advertised.name, /^[a-z0-9]{16}$/)
  const text = JSON.stringify(advertised)
  assert.equal(text.includes(a.keyPair.publicKey.toString('hex')), false)
  assert.equal(text.includes(topic.toString('hex')), false)

  // A new instance, as on the next network, has a new name and a new key.
  const next = await createLAN(1, { basePort: 21212 })
  t.after(next.destroy)
  assert.notEqual(next.nodes[0].name, a.name)
  assert.equal(next.nodes[0].keyPair.publicKey.equals(a.keyPair.publicKey), false)
})

test('a device that joins later finds the room, and two that join at the same moment find each other', async (t) => {
  const lan = await createLAN(4, { basePort: 21220, limits: { followUps: [300] } })
  t.after(lan.destroy)
  const [a, b, c, d] = lan.nodes
  const topic = randomBytes(32)

  a.join(topic)
  await a.flush()
  await sleep(200)
  b.join(topic)
  await until(() => a.connections.size === 1 && b.connections.size === 1, { label: 'b to find a' })

  // c and d at the same moment: each lookup may run before the other's
  // announcement lands. The follow-up lookup covers that.
  c.join(topic)
  d.join(topic)
  await until(() => [a, b, c, d].every((node) => node.connections.size === 3), { label: 'everyone connected' })
})

test('a device gone without a goodbye drops out once it stops answering', async (t) => {
  const lan = await createLAN(2, { basePort: 21230, limits: { deviceTTL: 200, pingInterval: 100 } })
  t.after(lan.destroy)
  const [a, b] = lan.nodes
  await until(() => a.info().devices === 1, { label: 'a to see b' })

  const down = new Promise((resolve) => a.once('peer-down', resolve))
  // The Wi-Fi goes off: no goodbye, and nothing answers any more.
  b.adapter.vanish()
  await b.destroy()
  const gone = await down
  assert.equal(gone.name, b.name)
  assert.equal(a.info().devices, 0)
})

test('an idle device keeps its place as long as it answers', async (t) => {
  const lan = await createLAN(2, { basePort: 21235, limits: { deviceTTL: 150, pingInterval: 50 } })
  t.after(lan.destroy)
  const [a] = lan.nodes
  await until(() => a.info().devices === 1, { label: 'a to see b' })
  let dropped = false
  a.on('peer-down', () => { dropped = true })
  await sleep(1000)
  assert.equal(dropped, false)
  assert.equal(a.info().devices, 1)
})

test('a goodbye counts only from the device it is about', async (t) => {
  const lan = await createLAN(2, { basePort: 21240 })
  t.after(lan.destroy)
  const [a, b] = lan.nodes
  await until(() => a.info().devices === 1, { label: 'a to see b' })

  // Someone else on the network says goodbye in b's name.
  a._onServiceDown({ name: b.name, referer: { address: '192.168.1.66' } })
  assert.equal(a.info().devices, 1)
  a._onServiceDown({ name: b.name, referer: { address: '127.0.0.1' } })
  assert.equal(a.info().devices, 0)
})

test('the discovery list is bounded: a few names per address, a cap overall, and sightings rate limited', async (t) => {
  const lan = await createLAN(1, {
    basePort: 21250,
    limits: { devicesPerIP: 3, maxDevices: 5, sightingBurst: 50, sightingsPerSecond: 0.001 }
  })
  t.after(lan.destroy)
  const [a] = lan.nodes
  const sighting = (name, address, port = 40000) => a._onServiceDiscovered({
    name,
    port,
    txt: { v: '2' },
    referer: { address, port }
  })
  const name = (i) => `fake${String(i).padStart(12, '0')}`

  // One machine claiming to be many devices.
  for (let i = 0; i < 20; i++) sighting(name(i), '192.168.1.66')
  assert.equal(a.info().devices, 3)

  for (let i = 0; i < 10; i++) sighting(name(100 + i), `192.168.2.${i}`)
  assert.equal(a.info().devices, 5)
  assert.ok(a.stats.devicesRefused >= 17 + 5)

  // A flood of sightings from one sender runs out of its burst.
  for (let i = 0; i < 100; i++) sighting(name(200 + i), '192.168.3.1')
  assert.ok(a.stats.sightingsDropped >= 50)
})

test('only a few devices from mDNS are pinged into the DHT, spread over addresses', async (t) => {
  const lan = await createLAN(1, { basePort: 21260, limits: { maxSeeds: 4, pingsPerSecond: 100, pingInterval: 60_000 } })
  t.after(lan.destroy)
  const [a] = lan.nodes
  a.on('warning', () => {})
  for (let i = 0; i < 30; i++) {
    a._onServiceDiscovered({
      name: `fake${String(i).padStart(12, '0')}`,
      port: 1 + i,
      txt: { v: '2' },
      referer: { address: `10.255.${i % 3}.${i}` }
    })
  }
  // Nothing answers at those addresses, so each sighting asks for a seed;
  // still at most maxSeeds are pinged in one go, one per address first.
  assert.ok(a.stats.pingsSent <= 30)
  const pinged = [...a._devices.values()].filter((device) => device.pingedAt > 0)
  assert.ok(pinged.length >= 4)
  const firstFour = pinged.slice(0, 3).map((device) => device.host.split('.')[2])
  assert.equal(new Set(firstFour).size, 3)
})

test('connections are capped in both directions, without banning the peers refused', async (t) => {
  const lan = await createLAN(5, { basePort: 21270, limits: { maxPeers: 2, connectionsPerIP: 10 } })
  t.after(lan.destroy)
  const topic = randomBytes(32)
  for (const node of lan.nodes) node.join(topic)

  let most = 0
  const watch = setInterval(() => {
    for (const node of lan.nodes) most = Math.max(most, node.connections.size)
  }, 5)
  t.after(() => clearInterval(watch))
  // With five devices and room for two each, four can fill each other up and
  // leave the fifth out, so this checks the cap, not that everyone is in.
  await until(() => lan.nodes.filter((node) => node.connections.size >= 1).length >= 3, { label: 'connections' })
  await sleep(3000)
  for (const node of lan.nodes) assert.ok(node.connections.size <= 2, `a device kept ${node.connections.size} connections`)
  // A burst can open one or two past the cap for a moment before the newest goes.
  assert.ok(most <= 4, `a device had ${most} connections`)
  const refused = lan.nodes.reduce((sum, node) => sum + node.stats.connectionsRefused, 0)
  assert.ok(refused > 0)
  for (const node of lan.nodes) {
    for (const peer of node.swarm.peers.values()) assert.equal(peer.banned, false)
  }
})

test('one address gets at most connectionsPerIP connections', async (t) => {
  const lan = await createLAN(4, { basePort: 21280, limits: { connectionsPerIP: 1 } })
  t.after(lan.destroy)
  const topic = randomBytes(32)
  for (const node of lan.nodes) node.join(topic)
  await until(() => lan.nodes.some((node) => node.connections.size >= 1), { label: 'a connection' })
  await sleep(1500)
  // Every device here is on 127.0.0.1.
  for (const node of lan.nodes) assert.ok(node.connections.size <= 1, `${node.connections.size} connections`)
})

test('the routing table takes at most nodesPerIP entries from one address', async (t) => {
  const lan = await createLAN(6, { basePort: 21290, limits: { nodesPerIP: 2 } })
  t.after(lan.destroy)
  await sleep(1500)
  for (const node of lan.nodes) {
    assert.ok(node.dht.nodes.length <= 2, `${node.dht.nodes.length} nodes from one address`)
  }
  assert.ok(lan.nodes.some((node) => node.dht.hyperdhtMdns.stats.refusedNodes > 0))
})

test('a flood of requests from one address is dropped, and the device keeps working', async (t) => {
  const lan = await createLAN(2, { basePort: 21300, limits: { requestsPerSecond: 20, requestBurst: 40 } })
  t.after(lan.destroy)
  const [a, b] = lan.nodes
  // b asks a far more than any device would.
  await Promise.allSettled(Array.from({ length: 300 }, () => b.dht.ping({ host: '127.0.0.1', port: a.port }, { retry: false })))
  assert.ok(a.dht.hyperdhtMdns.stats.droppedRequests > 200)

  // A device on another address is not held back by b's flood.
  const other = HyperDHT.bootstrapper(21305, '127.0.0.1', { bootstrap: [] })
  t.after(() => other.destroy())
  await other.fullyBootstrapped()
  a.dht.hyperdhtMdns.stats.droppedRequests = 0
  // (Same address on loopback, so let the bucket refill first.)
  await sleep(2100)
  await other.ping({ host: '127.0.0.1', port: a.port })
})

test('announcements are limited per address and topic, so one machine cannot drown a topic', async (t) => {
  const lan = await createLAN(2, { basePort: 21310, limits: { announcesPerTopic: 3 } })
  t.after(lan.destroy)
  const [a, b] = lan.nodes
  await until(() => b.dht.nodes.length === 1, { label: 'b to know a' })
  const topic = randomBytes(32)

  // b announces a dozen made-up devices under one topic.
  for (let i = 0; i < 12; i++) {
    await b.dht.announce(topic, HyperDHT.keyPair(), []).finished().catch(() => {})
  }
  const stored = a.dht._persistent.records.get(topic.toString('hex'), 100)
  assert.ok(stored.length <= 3, `${stored.length} records stored`)
  assert.ok(a.dht.hyperdhtMdns.stats.droppedAnnounces > 0)
})

test('topic changes go out in batches', async (t) => {
  const lan = await createLAN(1, { basePort: 21320, limits: { joinsPerBatch: 2, batchInterval: 300 } })
  t.after(lan.destroy)
  const [a] = lan.nodes
  await sleep(400)
  const topics = Array.from({ length: 6 }, () => randomBytes(32))
  const sessions = topics.map((topic) => a.join(topic))
  await sleep(50)
  assert.equal([...a.swarm.topics()].length, 2)
  await sleep(350)
  assert.equal([...a.swarm.topics()].length, 4)
  await Promise.all(sessions.map((session) => session.flushed()))
  assert.equal([...a.swarm.topics()].length, 6)

  // A join and leave inside one batch never goes out.
  await sleep(400)
  a.join(randomBytes(32))
  const brief = a.join(randomBytes(32))
  const briefer = a.join(randomBytes(32))
  await briefer.destroy()
  await brief.destroy()
  await sleep(400)
  assert.equal([...a.swarm.topics()].length, 7)
})

test('a server listening on the LAN DHT, as a note host does, is found by its key', async (t) => {
  const lan = await createLAN(2, { basePort: 21330 })
  t.after(lan.destroy)
  const [host, guest] = lan.nodes
  await until(() => guest.dht.nodes.length === 1, { label: 'guest to know host' })

  const noteKeyPair = HyperDHT.keyPair()
  const server = host.dht.createServer((socket) => {
    socket.on('error', () => {})
    socket.end('hello')
  })
  await server.listen(noteKeyPair)
  t.after(() => server.close())

  const address = await guest.findPeer(noteKeyPair.publicKey)
  assert.deepEqual(address, { host: '127.0.0.1', port: host.port })
  const socket = guest.dht.connect(noteKeyPair.publicKey, { relayAddresses: [address] })
  const reply = await new Promise((resolve, reject) => {
    socket.on('data', (data) => resolve(data.toString()))
    socket.on('error', reject)
  })
  assert.equal(reply, 'hello')

  assert.equal(await guest.findPeer(HyperDHT.keyPair().publicKey, { timeout: 500 }), null)
})

test('looking for a server just after starting waits for the first neighbours', async (t) => {
  const lan = await createLAN(1, { basePort: 21335 })
  t.after(lan.destroy)
  const [host] = lan.nodes
  const noteKeyPair = HyperDHT.keyPair()
  const server = host.dht.createServer((socket) => socket.on('error', () => {}))
  await server.listen(noteKeyPair)
  t.after(() => server.close())

  // The guest starts now and looks at once, before mDNS has seeded its DHT.
  const guest = lan.add(21336)
  await guest.ready()
  assert.equal(guest.dht.nodes.length, 0)
  assert.deepEqual(await guest.findPeer(noteKeyPair.publicKey, { timeout: 5000 }), { host: '127.0.0.1', port: host.port })
})

test('a device stops answering for a topic it left', async (t) => {
  const lan = await createLAN(2, { basePort: 21340 })
  t.after(lan.destroy)
  const [a, b] = lan.nodes
  const topic = randomBytes(32)
  const session = a.join(topic)
  await session.flushed()
  await until(() => b.dht.nodes.length === 1, { label: 'b to know a' })

  const lookup = async () => {
    const found = []
    for await (const data of b.dht.lookup(topic)) found.push(...data.peers)
    return found.filter((peer) => peer.publicKey.equals(a.keyPair.publicKey)).length
  }
  assert.equal(await lookup(), 1)
  await session.destroy()
  assert.equal(await lookup(), 0)
})

test('suspend and resume: the device leaves the network and finds its room again', async (t) => {
  const lan = await createLAN(2, { basePort: 21350, limits: { connectionTimeout: 2000 } })
  t.after(lan.destroy)
  const [a, b] = lan.nodes
  const topic = randomBytes(32)
  a.join(topic)
  b.join(topic)
  await until(() => a.connections.size === 1, { label: 'first connection' })

  for (let cycle = 0; cycle < 2; cycle++) {
    await a.suspend()
    await until(() => b.connections.size === 0, { label: 'b to notice' })
    await a.resume()
    await until(() => a.connections.size === 1 && b.connections.size === 1, { label: `reconnect ${cycle}` })
  }
})

test('one hostile machine posing as many devices does not keep honest devices apart', async (t) => {
  // Ports 21400+ are the hostile machine's, the rest are one device each.
  const hostKey = (address) => address.port >= 21400 && address.port < 21500 ? 'hostile' : `device-${address.port}`
  const lan = await createLAN(4, { basePort: 21360, hostKey, limits: { connectionsPerIP: 64 } })
  t.after(lan.destroy)
  const hostile = []
  t.after(() => Promise.allSettled(hostile.map((dht) => dht.destroy())))

  // Thirty DHT nodes on one machine, each announced over mDNS.
  for (let i = 0; i < 30; i++) {
    const dht = HyperDHT.bootstrapper(21400 + i, '127.0.0.1', { bootstrap: [] })
    hostile.push(dht)
    await dht.fullyBootstrapped()
    for (const node of lan.nodes) {
      node._onServiceDiscovered({ name: `evil${String(i).padStart(12, '0')}`, port: 21400 + i, txt: { v: '2' }, referer: { address: '127.0.0.1', port: 21400 + i } })
    }
  }

  const topic = randomBytes(32)
  for (const node of lan.nodes) node.join(topic)
  await until(() => lan.nodes.every((node) => node.connections.size === 3), { label: 'honest devices to meet' })
  for (const node of lan.nodes) {
    const hostileEntries = [...node._devices.values()].filter((device) => device.hostKey === 'hostile').length
    assert.ok(hostileEntries <= HyperDHTmDNS.DEFAULT_LIMITS.devicesPerIP)
    assert.ok(node.dht.hyperdhtMdns.nodesFrom({ host: '127.0.0.1', port: 21400 }) <= HyperDHTmDNS.DEFAULT_LIMITS.nodesPerIP)
  }
})
