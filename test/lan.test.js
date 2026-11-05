'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { randomBytes } = require('crypto')
const HyperDHT = require('hyperdht')
const HyperDHTmDNS = require('..')
const { createLAN, nextConnection, until, sleep } = require('../test-utils/lan-net')

// Ports 21200-21399 and 24000-24019, below the ephemeral range so nothing
// else takes them.

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
  const lan = await createLAN(2, { basePort: 21240, limits: { maxSeeds: 0 } })
  t.after(lan.destroy)
  const [a, b] = lan.nodes
  await until(() => a.info().devices === 1, { label: 'a to see b' })

  // Someone else on the network says goodbye in b's name.
  a._onServiceDown({ name: b.name, referer: { address: '192.168.1.66' } })
  assert.equal(a.info().devices, 1)
  // From b's own address, for a device not pinged yet: gone at once.
  a._onServiceDown({ name: b.name, referer: { address: '127.0.0.1' } })
  assert.equal(a.info().devices, 0)
})

test('a device that answers keeps its place and port, whatever is said in its name', async (t) => {
  const lan = await createLAN(2, { basePort: 21242, limits: { goodbyeWait: 100 } })
  t.after(lan.destroy)
  const [a, b] = lan.nodes
  a.on('warning', () => {})
  const entry = () => [...a._devices.values()].find((device) => device.name === b.name)
  await until(() => entry()?.reachable, { label: 'a to ping b' })

  // Anyone can send these from b's address: a new port, and a goodbye.
  let down = false
  a.on('peer-down', () => { down = true })
  a._onServiceDiscovered({ name: b.name, port: 21249, txt: { v: '2' }, referer: { address: '127.0.0.1', port: 21249 } })
  a._onServiceDown({ name: b.name, referer: { address: '127.0.0.1' } })
  assert.equal(entry().port, b.port)
  assert.equal(down, false)

  // b answers the ping that follows, so it stays, at its own port.
  await until(() => entry().goodbye === 0, { label: 'the goodbye to be checked' })
  assert.equal(entry().port, b.port)
  assert.equal(entry().nextPort, 0)
  assert.equal(entry().reachable, true)
  assert.equal(down, false)

  // When b really goes, its goodbye counts once it stops answering. The
  // wait is longer than b takes to shut down, as the default is.
  a.limits.goodbyeWait = 1000
  const gone = []
  a.on('peer-down', (device) => gone.push(device.name))
  await b.destroy()
  await until(() => gone.includes(b.name), { timeout: 30_000, label: 'b to be let go after its goodbye' })
  assert.equal(a.info().devices, 0)
})

test('a ping on its way when a goodbye comes does not settle it: the device is asked again after the wait', async (t) => {
  const lan = await createLAN(1, { basePort: 24012, limits: { goodbyeWait: 100 } })
  t.after(lan.destroy)
  const [a] = lan.nodes
  a.on('warning', () => {})
  // Pings are answered by hand, so one can be kept on its way.
  const pings = []
  a.dht.ping = () => new Promise((resolve, reject) => pings.push({ resolve, reject }))
  const name = 'leaving000000001'
  const entry = () => a._devices.get(`${name}@127.0.0.1`)
  const gone = []
  a.on('peer-down', (device) => gone.push(device.name))

  a._onServiceDiscovered({ name, port: 24013, txt: { v: '2' }, referer: { address: '127.0.0.1', port: 24013 } })
  assert.equal(pings.length, 1)
  // It says goodbye while that first ping is on its way, and the ping is
  // answered: the device was still there when the ping went out.
  a._onServiceDown({ name, referer: { address: '127.0.0.1' } })
  pings.shift().resolve()
  await sleep(10)
  assert.equal(entry().reachable, true)
  assert.ok(entry().goodbye > 0, 'the goodbye is still to be checked')

  // Asked again once the wait is over, and gone by then.
  await until(() => pings.length === 1, { label: 'the ping after the goodbye' })
  pings.shift().reject(new Error('Nothing there'))
  await until(() => gone.includes(name), { label: 'the device to be let go' })
  assert.equal(entry(), undefined)
})

test('a seed kept in sight by sightings is still asked now and then, so one that stopped answering is no longer a seed', async (t) => {
  const lan = await createLAN(1, {
    basePort: 24000,
    limits: { deviceTTL: 500, pingInterval: 100, sightingsPerSecond: 100, sightingBurst: 100 },
    // Pings to nothing fail in a few hundred milliseconds.
    opts: { dhtOptions: { adaptiveTimeout: { fallback: [100], jitter: 0 } } }
  })
  t.after(lan.destroy)
  const [a] = lan.nodes
  a.on('warning', () => {})
  // A DHT node on this computer, as another device.
  const other = HyperDHT.bootstrapper(24001, '127.0.0.1', { bootstrap: [] })
  t.after(() => other.destroy())
  await other.fullyBootstrapped()

  const name = 'seen000000000001'
  const see = () => a._onServiceDiscovered({ name, port: 24001, txt: { v: '2' }, referer: { address: '127.0.0.1', port: 24001 } })
  const entry = () => a._devices.get(`${name}@127.0.0.1`)
  see()
  await until(() => entry()?.reachable, { label: 'the device to answer' })

  // Sightings keep coming, as anyone can send them, after it has gone.
  const sightings = setInterval(see, 50)
  t.after(() => clearInterval(sightings))
  await other.destroy()
  await until(() => !entry()?.reachable, { timeout: 15_000, label: 'the gone device to stop counting as a seed' })
  assert.ok(entry().failures > 0)
})

test('a seed seen at another port is asked there once its own port stops answering', async (t) => {
  const lan = await createLAN(1, {
    basePort: 24002,
    // Long enough that the old port is gone before it is asked again.
    limits: { deviceTTL: 2000, pingInterval: 100 },
    opts: { dhtOptions: { adaptiveTimeout: { fallback: [100], jitter: 0 } } }
  })
  t.after(lan.destroy)
  const [a] = lan.nodes
  a.on('warning', () => {})
  // The device's DHT node before and after it moved to another port.
  const before = HyperDHT.bootstrapper(24003, '127.0.0.1', { bootstrap: [] })
  const after = HyperDHT.bootstrapper(24004, '127.0.0.1', { bootstrap: [] })
  t.after(() => Promise.allSettled([before.destroy(), after.destroy()]))
  await Promise.all([before.fullyBootstrapped(), after.fullyBootstrapped()])

  const name = 'moved00000000001'
  const see = (port) => a._onServiceDiscovered({ name, port, txt: { v: '2' }, referer: { address: '127.0.0.1', port } })
  const entry = () => a._devices.get(`${name}@127.0.0.1`)
  see(24003)
  await until(() => entry()?.reachable, { label: 'the device to answer at its first port' })

  // Seen once at the new port: kept at the one that answers for now.
  see(24004)
  assert.equal(entry().port, 24003)
  assert.equal(entry().nextPort, 24004)

  // The old port goes quiet, and nothing is seen after: the device is
  // asked at the new port and found there.
  await before.destroy()
  await until(() => entry()?.port === 24004 && entry().reachable, { timeout: 15_000, label: 'the device to be found at its new port' })
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

test('made-up devices filling the discovery list do not keep out a device that answers', async (t) => {
  const lan = await createLAN(1, {
    basePort: 21370,
    // Pings to nothing fail in under a second rather than in four or more,
    // so the made-up devices are through their first ping sooner.
    limits: { pingsPerSecond: 100 },
    opts: { dhtOptions: { adaptiveTimeout: { fallback: [100], jitter: 0 }, maxWindow: 1000 } }
  })
  t.after(lan.destroy)
  const [a] = lan.nodes
  a.on('warning', () => {})
  const name = (i) => `fake${String(i).padStart(12, '0')}`

  // 256 made-up devices, four names from each of 64 made-up addresses, seen
  // again and again so none goes quiet. Loopback addresses, so the pings to
  // them stay on this computer.
  const forged = Array.from({ length: 256 }, (_, i) => ({
    name: name(i),
    port: 21399,
    txt: { v: '2' },
    referer: { address: `127.9.${i >> 2}.1`, port: 5353 }
  }))
  const announce = () => { for (const service of forged) a._onServiceDiscovered(service) }
  announce()
  const again = setInterval(announce, 200)
  t.after(() => clearInterval(again))
  assert.equal(a.info().devices, 256)

  // In 2.0.0 the list made room only for a device that had gone quiet.
  const b = lan.add(21371)
  await b.ready()
  const entry = () => [...a._devices.values()].find((device) => device.name === b.name)
  await until(() => entry()?.reachable, { timeout: 40_000, label: 'the honest device to become a seed' })
  assert.equal(a.info().devices, 256)

  // More made-up names push out made-up ones, never the device that answers.
  for (let i = 0; i < 300; i++) {
    a._onServiceDiscovered({ name: name(1000 + i), port: 21399, txt: { v: '2' }, referer: { address: `127.10.${i >> 2}.1`, port: 5353 } })
  }
  assert.equal(a.info().devices, 256)
  assert.equal(entry()?.reachable, true)
})

test('a full list drops a device whose pings failed first, then one not asked yet, never one that answered', async (t) => {
  // No pings and no sweeps: each device's state is set by hand.
  const lan = await createLAN(1, { basePort: 21380, limits: { maxDevices: 4, maxSeeds: 0, sweepInterval: 60_000 } })
  t.after(lan.destroy)
  const [a] = lan.nodes
  const name = (i) => `fake${String(i).padStart(12, '0')}`
  const see = (i) => a._onServiceDiscovered({ name: name(i), port: 21399, txt: { v: '2' }, referer: { address: `127.9.0.${i}`, port: 5353 } })
  const listed = () => [...a._devices.values()].map((device) => device.name).sort()
  for (let i = 0; i < 4; i++) see(i)
  const [answered, failedOnce, failedTwice] = [0, 1, 2].map((i) => a._devices.get(`${name(i)}@127.9.0.${i}`))
  answered.reachable = true
  answered.pingedAt = Date.now()
  failedOnce.failures = 1
  failedOnce.pingedAt = Date.now()
  failedTwice.failures = 2
  failedTwice.pingedAt = Date.now()

  see(4)
  assert.deepEqual(listed(), [name(0), name(1), name(3), name(4)])
  see(5)
  assert.deepEqual(listed(), [name(0), name(3), name(4), name(5)])
  // Then one not asked yet, at random, and never the one that answered.
  for (let i = 6; i < 30; i++) {
    see(i)
    assert.equal(a.info().devices, 4)
    assert.ok(listed().includes(name(0)))
    assert.ok(listed().includes(name(i)))
  }
})

test('devices not asked yet are pinged before those that did not answer are asked again', async (t) => {
  const lan = await createLAN(1, { basePort: 21382, limits: { maxSeeds: 8, pingInterval: 100, sweepInterval: 60_000 } })
  t.after(lan.destroy)
  const [a] = lan.nodes
  a.on('warning', () => {})
  // Nothing answers, and nothing goes on the network.
  const pinged = []
  a.dht.ping = async ({ host }) => {
    pinged.push(host)
    throw new Error('Nothing there')
  }
  const see = (i) => a._onServiceDiscovered({ name: `fake${String(i).padStart(12, '0')}`, port: 21399, txt: { v: '2' }, referer: { address: `127.9.1.${i}`, port: 5353 } })

  for (let i = 0; i < 8; i++) see(i)
  await sleep(10)
  assert.equal(pinged.length, 8)
  // Their wait to be asked again is over, and there is room for one seed.
  await sleep(250)
  a.limits.maxSeeds = 1
  see(8)
  await sleep(10)
  assert.deepEqual(pinged.slice(8), ['127.9.1.8'])
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

test('a device whose address is gone when it resumes stays suspended, and comes back with the address', async (t) => {
  const lan = await createLAN(1, { basePort: 24010 })
  t.after(lan.destroy)
  const [a] = lan.nodes
  const other = HyperDHT.bootstrapper(24011, '127.0.0.1', { bootstrap: [] })
  t.after(() => other.destroy())
  await other.fullyBootstrapped()
  await other.ping({ host: '127.0.0.1', port: a.port })

  // While it is suspended its address goes, as with the Wi-Fi off: nothing
  // can listen on it.
  await a.suspend()
  let gone = true
  const createSocket = a.dht.udx.createSocket
  a.dht.udx.createSocket = function (...args) {
    const socket = createSocket.apply(this, args)
    const bind = socket.bind
    socket.bind = function (port, host) {
      if (gone && host === a.host) {
        const error = new Error(`bind EADDRNOTAVAIL ${host}:${port}`)
        error.code = 'EADDRNOTAVAIL'
        throw error
      }
      return bind.call(this, port, host)
    }
    return socket
  }
  await assert.rejects(a.resume(), { code: 'ERR_LAN_ADDRESS_UNAVAILABLE' })
  assert.equal(a.suspended, true)

  // The address is back: the DHT listens and answers again.
  gone = false
  await a.resume()
  assert.equal(a.suspended, false)
  await other.ping({ host: '127.0.0.1', port: a.port })
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
