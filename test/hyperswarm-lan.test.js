'use strict'

const { EventEmitter } = require('events')
const test = require('node:test')
const assert = require('node:assert/strict')
const HyperswarmLAN = require('..')

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

class FakeDiscovery extends EventEmitter {
  start (record, onPeer) {
    this.record = record
    this.onPeer = onPeer
  }

  update (record) { this.record = record }
  stop () { return Promise.resolve() }
  destroy () { return Promise.resolve() }
}

test('adds a discovered endpoint and refreshes active topics', async () => {
  const dht = new FakeDHT()
  const keyPair = { publicKey: Buffer.alloc(32, 1) }
  const swarm = new FakeSwarm(dht, keyPair)
  const discovery = new FakeDiscovery()
  const lan = new HyperswarmLAN({
    host: '127.0.0.1',
    port: 49799,
    dht,
    swarm,
    discovery,
    eager: false
  })

  await lan.ready()
  const topic = Buffer.alloc(32, 10)
  lan.join(topic)
  discovery.onPeer({
    port: 49800,
    txt: { v: '1', peerKey: Buffer.alloc(32, 2).toString('hex'), tc: '0' },
    referer: { address: '192.168.1.9' }
  })

  await new Promise((resolve) => lan.once('peer-reachable', resolve))

  assert.equal(dht.nodes.length, 1)
  assert.equal(dht.nodes[0].host, '192.168.1.9')
  assert.equal(dht.pings.length, 1)
  assert.equal(dht.refreshes, 1)
  assert.equal(swarm.discovery.refreshes, 2)

  await lan.destroy()
})

test('ignores its own mDNS record', async () => {
  const dht = new FakeDHT()
  const keyPair = { publicKey: Buffer.alloc(32, 3) }
  const swarm = new FakeSwarm(dht, keyPair)
  const discovery = new FakeDiscovery()
  const lan = new HyperswarmLAN({ host: '127.0.0.1', dht, swarm, discovery, eager: false })

  await lan.ready()
  discovery.onPeer({
    port: 49799,
    txt: { v: '1', peerKey: keyPair.publicKey.toString('hex'), tc: '0' },
    referer: { address: '192.168.1.10' }
  })
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(dht.nodes.length, 0)
  await lan.destroy()
})

test('can be destroyed while startup is in progress', async () => {
  const dht = new FakeDHT()
  const keyPair = { publicKey: Buffer.alloc(32, 4) }
  const swarm = new FakeSwarm(dht, keyPair)
  const discovery = new FakeDiscovery()
  let release

  dht.fullyBootstrapped = () => new Promise((resolve) => { release = resolve })

  const lan = new HyperswarmLAN({ host: '127.0.0.1', dht, swarm, discovery, eager: false })
  const destroying = lan.destroy()
  release()
  await destroying

  assert.equal(discovery.record, undefined)
  assert.equal(lan.destroyed, true)
})

test('join and session destroy update the advertised topic tokens', async () => {
  const dht = new FakeDHT()
  const keyPair = { publicKey: Buffer.alloc(32, 5) }
  const swarm = new FakeSwarm(dht, keyPair)
  const discovery = new FakeDiscovery()
  const lan = new HyperswarmLAN({ host: '127.0.0.1', dht, swarm, discovery, eager: false })

  await lan.ready()
  const session = lan.join(Buffer.alloc(32, 12))
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(discovery.record.txt.tc, '1')

  await session.destroy()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(discovery.record.txt.tc, '0')

  await lan.destroy()
})
