'use strict'

const { EventEmitter, once } = require('events')
const test = require('node:test')
const assert = require('node:assert/strict')
const HyperDHTmDNS = require('..')
const { topicToken } = require('../src/record')

class FakeDHT {
  constructor () {
    this.nodes = []
    this.pings = []
    this.refreshes = 0
    this.connections = []
  }

  fullyBootstrapped () { return Promise.resolve() }
  address () { return { host: '0.0.0.0', port: 49799 } }
  addNode (peer) { this.nodes.push(peer) }
  ping (peer) { this.pings.push(peer); return Promise.resolve() }
  refresh () { this.refreshes++ }
}

class FakeSwarm extends EventEmitter {
  constructor (dht, keyPair) {
    super()
    this.dht = dht
    this.keyPair = keyPair
    this.connections = new Set()
    this.peers = new Map()
    this.discovery = {
      refreshes: 0,
      refresh () { this.refreshes++ },
      flushed () { return Promise.resolve(true) },
      destroy () { return Promise.resolve() }
    }
  }

  listen () { return Promise.resolve() }
  join () { return this.discovery }
  leave () { return Promise.resolve() }
  joinPeer () {}
  leavePeer () {}
  flush () { return Promise.resolve(true) }
  topics () { return [this.discovery] }
  status () { return this.discovery }
  suspend () { return Promise.resolve() }
  resume () { return Promise.resolve() }
  destroy () { return Promise.resolve() }
}

class FakeAdapter {
  browse (query, handlers) {
    this.query = query
    this.handlers = handlers
    return { stop: () => { this.browserStopped = true } }
  }

  advertise (record) {
    this.record = record
    return { stop: () => { this.advertisementStopped = true } }
  }

  discover (service) { this.handlers.onService(service) }
  down (service) { this.handlers.onServiceDown(service) }
}

test('adds a discovered endpoint and refreshes active topics', async () => {
  const dht = new FakeDHT()
  const keyPair = { publicKey: Buffer.alloc(32, 1) }
  const swarm = new FakeSwarm(dht, keyPair)
  const adapter = new FakeAdapter()
  const lan = new HyperDHTmDNS({
    host: '127.0.0.1',
    port: 49799,
    dht,
    swarm,
    adapter,
    eager: false
  })

  await lan.ready()
  const topic = Buffer.alloc(32, 10)
  lan.join(topic)
  adapter.discover({
    port: 49800,
    txt: { v: '1', peerKey: Buffer.alloc(32, 2).toString('hex'), tc: '0' },
    referer: { address: '192.168.1.9' }
  })

  await new Promise((resolve) => lan.once('peer-reachable', resolve))

  assert.equal(dht.nodes.length, 1)
  assert.equal(dht.nodes[0].host, '192.168.1.9')
  assert.equal(dht.pings.length, 1)
  assert.equal(dht.refreshes, 1)
  assert.equal(swarm.discovery.refreshes, 1)

  await lan.destroy()
})

test('ignores its own mDNS record', async () => {
  const dht = new FakeDHT()
  const keyPair = { publicKey: Buffer.alloc(32, 3) }
  const swarm = new FakeSwarm(dht, keyPair)
  const adapter = new FakeAdapter()
  const lan = new HyperDHTmDNS({ host: '127.0.0.1', dht, swarm, adapter, eager: false })

  await lan.ready()
  adapter.discover({
    port: 49799,
    txt: { v: '1', peerKey: keyPair.publicKey.toString('hex'), tc: '0' },
    referer: { address: '192.168.1.10' }
  })
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(dht.nodes.length, 0)
  await lan.destroy()
})

test('uses the fixed default port when no port is supplied', async () => {
  const dht = new FakeDHT()
  const keyPair = { publicKey: Buffer.alloc(32, 4) }
  const swarm = new FakeSwarm(dht, keyPair)
  const lan = new HyperDHTmDNS({ host: '127.0.0.1', dht, swarm, adapter: new FakeAdapter() })

  await lan.ready()
  assert.equal(lan.port, HyperDHTmDNS.DEFAULT_PORT)
  await lan.destroy()
})

test('wraps EADDRINUSE with a descriptive error on the default constructor path', async () => {
  const eaddrinuse = new Error('bind EADDRINUSE 0.0.0.0:49799')
  eaddrinuse.code = 'EADDRINUSE'
  const dht = new FakeDHT()
  dht.fullyBootstrapped = () => Promise.reject(eaddrinuse)
  const keyPair = { publicKey: Buffer.alloc(32, 14) }
  const swarm = new FakeSwarm(dht, keyPair)
  const lan = new HyperDHTmDNS({ host: '127.0.0.1', dht, swarm, adapter: new FakeAdapter() })

  await assert.rejects(lan.ready(), (error) => {
    assert.match(error.message, /LAN DHT port/)
    assert.match(error.message, /49799/)
    assert.equal(error.cause, eaddrinuse)
    return true
  })
  await lan.destroy()
})

test('forgets a matching peer when the discovery adapter reports it down', async () => {
  const dht = new FakeDHT()
  const keyPair = { publicKey: Buffer.alloc(32, 6) }
  const swarm = new FakeSwarm(dht, keyPair)
  const adapter = new FakeAdapter()
  const lan = new HyperDHTmDNS({ host: '127.0.0.1', dht, swarm, adapter, eager: false })
  const service = {
    port: 49800,
    txt: { v: '1', peerKey: Buffer.alloc(32, 7).toString('hex'), tc: '0' },
    referer: { address: '192.168.1.11' }
  }

  await lan.ready()
  const reachable = once(lan, 'peer-reachable')
  adapter.discover(service)
  await reachable
  assert.equal(lan._knownPeers.size, 1)

  const down = once(lan, 'peer-down')
  adapter.down(service)
  await down
  assert.equal(lan._knownPeers.size, 0)

  await lan.destroy()
})

test('forgets a peer when an older service-down record has stale details', async () => {
  const dht = new FakeDHT()
  const keyPair = { publicKey: Buffer.alloc(32, 6) }
  const swarm = new FakeSwarm(dht, keyPair)
  const adapter = new FakeAdapter()
  const lan = new HyperDHTmDNS({ host: '127.0.0.1', dht, swarm, adapter, eager: false })
  const service = {
    port: 49800,
    txt: { v: '1', peerKey: Buffer.alloc(32, 7).toString('hex'), tc: '0' },
    referer: { address: '192.168.1.11' }
  }

  await lan.ready()
  adapter.discover(service)
  await once(lan, 'peer-reachable')
  adapter.down({ ...service, port: 49801 })
  assert.equal(lan._knownPeers.size, 0)
  await lan.destroy()
})

test('does not destroy unmatched connections from a borrowed swarm', async () => {
  const dht = new FakeDHT()
  const keyPair = { publicKey: Buffer.alloc(32, 12) }
  const swarm = new FakeSwarm(dht, keyPair)
  const lan = new HyperDHTmDNS({ host: '127.0.0.1', swarm, adapter: new FakeAdapter() })
  const socket = {
    remotePublicKey: Buffer.alloc(32, 13),
    destroyed: false,
    destroy () { this.destroyed = true }
  }

  await lan.ready()
  lan._handleSwarmConnection(socket, { topics: [] })
  assert.equal(socket.destroyed, false)
  await lan.destroy()
})

test('can be destroyed while startup is in progress', async () => {
  const dht = new FakeDHT()
  const keyPair = { publicKey: Buffer.alloc(32, 4) }
  const swarm = new FakeSwarm(dht, keyPair)
  const adapter = new FakeAdapter()
  let release

  dht.fullyBootstrapped = () => new Promise((resolve) => { release = resolve })

  const lan = new HyperDHTmDNS({ host: '127.0.0.1', dht, swarm, adapter, eager: false })
  const destroying = lan.destroy()
  release()
  await destroying

  assert.equal(adapter.record, undefined)
  assert.equal(lan.destroyed, true)
})

test('join and session destroy update the advertised topic tokens', async () => {
  const dht = new FakeDHT()
  const keyPair = { publicKey: Buffer.alloc(32, 5) }
  const swarm = new FakeSwarm(dht, keyPair)
  const adapter = new FakeAdapter()
  const lan = new HyperDHTmDNS({ host: '127.0.0.1', dht, swarm, adapter, eager: false })

  await lan.ready()
  const session = lan.join(Buffer.alloc(32, 12))
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(adapter.record.txt.tc, '1')

  await session.destroy()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(adapter.record.txt.tc, '0')

  await lan.destroy()
})

test('resume reports an interface change instead of advertising an unbound address', async () => {
  const dht = new FakeDHT()
  const keyPair = { publicKey: Buffer.alloc(32, 8) }
  const swarm = new FakeSwarm(dht, keyPair)
  const adapter = new FakeAdapter()
  const lan = new HyperDHTmDNS({ host: '192.168.1.50', dht, swarm, adapter, eager: false })

  await lan.ready()

  // Discover a peer on the current subnet
  const topic = Buffer.alloc(32, 20)
  lan.join(topic)
  adapter.discover({
    port: 49800,
    txt: { v: '1', peerKey: Buffer.alloc(32, 9).toString('hex'), tc: '0' },
    referer: { address: '192.168.1.51' }
  })
  await once(lan, 'peer-reachable')
  assert.equal(lan._knownPeers.size, 1)

  // Suspend (simulates going offline / switching WiFi)
  await lan.suspend()
  assert.equal(lan.suspended, true)

  lan._autoHost = true
  await assert.rejects(lan.resume(), { code: 'ERR_LAN_INTERFACE_CHANGED' })
  assert.equal(lan.suspended, true)
  assert.equal(lan.host, '192.168.1.50')

  await lan.destroy()
})

test('joining more topics than the record can carry does not fail the join', async () => {
  const dht = new FakeDHT()
  const keyPair = { publicKey: Buffer.alloc(32, 1) }
  const swarm = new FakeSwarm(dht, keyPair)
  const adapter = new FakeAdapter()
  const lan = new HyperDHTmDNS({
    host: '127.0.0.1',
    port: 49799,
    dht,
    swarm,
    adapter,
    eager: false
  })

  await lan.ready()

  const warnings = []
  lan.on('warning', (error) => warnings.push(error))

  // Far more than fit in one TXT record. A consumer browsing hyper:// drives
  // reaches this within a single session, and every join used to throw a
  // RangeError out through hyperswarm once the record filled up.
  const topics = Array.from({ length: 40 }, (_, index) => Buffer.alloc(32, index))
  for (const topic of topics) {
    assert.doesNotThrow(() => lan.join(topic))
  }

  // Every topic is still tracked, so an incoming peer advertising one that did
  // not fit is still matched locally.
  assert.equal(lan._matchingTopics([topicToken(topics[0])]).length, 1)
  assert.equal(lan._matchingTopics([topicToken(topics[39])]).length, 1)

  await lan._advertisementQueue
  assert.ok(adapter.record.dropped > 0)
  assert.equal(adapter.record.advertised + adapter.record.dropped, topics.length)
  assert.equal(warnings.length, 1, 'expected one advertisement-full warning, not one per update')
  assert.match(warnings[0].message, /advertisement full/i)

  await lan.destroy()
})

test('releasing a topic stops advertising it', async () => {
  const dht = new FakeDHT()
  const keyPair = { publicKey: Buffer.alloc(32, 1) }
  const swarm = new FakeSwarm(dht, keyPair)
  const adapter = new FakeAdapter()
  const lan = new HyperDHTmDNS({
    host: '127.0.0.1',
    port: 49799,
    dht,
    swarm,
    adapter,
    eager: false
  })

  await lan.ready()

  const topic = Buffer.alloc(32, 3)
  const session = lan.join(topic)
  await lan._advertisementQueue
  assert.equal(adapter.record.advertised, 1)

  await session.destroy()
  await lan._advertisementQueue
  assert.equal(adapter.record.advertised, 0)
  assert.equal(lan._matchingTopics([topicToken(topic)]).length, 0)

  await lan.destroy()
})
