'use strict'

const { EventEmitter, once } = require('events')
const { randomBytes } = require('crypto')
const { rm } = require('fs/promises')
const { tmpdir } = require('os')
const path = require('path')
const test = require('node:test')
const assert = require('node:assert/strict')
const HyperswarmLAN = require('..')
const { attachHyperSDK } = HyperswarmLAN

class MemoryDiscovery extends EventEmitter {
  constructor (bus) {
    super()
    this.bus = bus
    this.record = null
    this.onPeer = null
  }

  start (record, onPeer) {
    this.record = record
    this.onPeer = onPeer

    for (const peer of this.bus) {
      setImmediate(() => {
        onPeer(asService(peer.record))
        peer.onPeer(asService(record))
      })
    }

    this.bus.add(this)
  }

  update (record) {
    this.record = record
    for (const peer of this.bus) {
      if (peer === this) continue
      setImmediate(() => peer.onPeer(asService(record)))
    }
  }

  stop () {
    this.bus.delete(this)
    return Promise.resolve()
  }

  destroy () {
    this.bus.delete(this)
    return Promise.resolve()
  }
}

test('two bootstrap-free swarms discover a shared topic through injected LAN nodes', { timeout: 30_000 }, async (t) => {
  const bus = new Set()
  const a = new HyperswarmLAN({
    host: '127.0.0.1',
    port: 49831,
    allowLoopback: true,
    discovery: new MemoryDiscovery(bus)
  })
  const b = new HyperswarmLAN({
    host: '127.0.0.1',
    port: 49832,
    allowLoopback: true,
    discovery: new MemoryDiscovery(bus)
  })

  t.after(async () => Promise.allSettled([a.destroy(), b.destroy()]))

  const topic = randomBytes(32)
  a.join(topic)
  b.join(topic)

  const aConnection = once(a, 'connection')
  const bConnection = once(b, 'connection')

  await Promise.all([a.ready(), b.ready()])
  const [[aSocket, aInfo], [bSocket, bInfo]] = await Promise.all([aConnection, bConnection])
  aSocket.on('error', () => {})
  bSocket.on('error', () => {})

  assert.equal(aSocket.remotePublicKey.equals(b.keyPair.publicKey), true)
  assert.equal(bSocket.remotePublicKey.equals(a.keyPair.publicKey), true)
  assert.deepEqual(aInfo.topics, [topic])
  assert.deepEqual(bInfo.topics, [topic])
  assert.equal(a.dht.bootstrapNodes.length, 0)
  assert.equal(b.dht.bootstrapNodes.length, 0)
})

test('nodes on different topics discover DHT endpoints but do not connect', { timeout: 10_000 }, async (t) => {
  const bus = new Set()
  const a = new HyperswarmLAN({
    host: '127.0.0.1',
    port: 49833,
    allowLoopback: true,
    discovery: new MemoryDiscovery(bus)
  })
  const b = new HyperswarmLAN({
    host: '127.0.0.1',
    port: 49834,
    allowLoopback: true,
    discovery: new MemoryDiscovery(bus)
  })
  t.after(async () => Promise.allSettled([a.destroy(), b.destroy()]))

  a.join(randomBytes(32))
  b.join(randomBytes(32))
  let connected = false
  a.on('connection', () => { connected = true })
  b.on('connection', () => { connected = true })

  const reachableA = once(a, 'peer-reachable')
  const reachableB = once(b, 'peer-reachable')
  await Promise.all([a.ready(), b.ready(), reachableA, reachableB])
  await new Promise((resolve) => setTimeout(resolve, 500))

  assert.equal(connected, false)
})

test('joining a shared topic after discovery triggers a matched connection', { timeout: 15_000 }, async (t) => {
  const bus = new Set()
  const a = new HyperswarmLAN({
    host: '127.0.0.1',
    port: 49835,
    allowLoopback: true,
    discovery: new MemoryDiscovery(bus)
  })
  const b = new HyperswarmLAN({
    host: '127.0.0.1',
    port: 49836,
    allowLoopback: true,
    discovery: new MemoryDiscovery(bus)
  })
  t.after(async () => Promise.allSettled([a.destroy(), b.destroy()]))

  await Promise.all([a.ready(), b.ready()])
  const topic = randomBytes(32)
  b.join(topic)
  a.join(topic)

  const [[socket, info]] = await Promise.all([
    Promise.race([once(a, 'connection'), once(b, 'connection')])
  ])
  socket.on('error', () => {})
  assert.deepEqual(info.topics, [topic])
})

test('hyper-sdk 6.2.2 receives matched LAN connections while public DHT is isolated', { timeout: 30_000 }, async (t) => {
  const { create } = await import('hyper-sdk')
  const suffix = randomBytes(6).toString('hex')
  const storageA = path.join(tmpdir(), `hyperswarm-lan-sdk-a-${suffix}`)
  const storageB = path.join(tmpdir(), `hyperswarm-lan-sdk-b-${suffix}`)
  const bus = new Set()
  const sdks = []

  t.after(async () => {
    await Promise.allSettled(sdks.map(sdk => sdk.close()))
    await Promise.allSettled([
      rm(storageA, { recursive: true, force: true }),
      rm(storageB, { recursive: true, force: true })
    ])
  })

  const sdkA = await create({ storage: storageA, swarmOpts: { bootstrap: [], port: 49837 } })
  sdks.push(sdkA)
  const sdkB = await create({ storage: storageB, swarmOpts: { bootstrap: [], port: 49838 } })
  sdks.push(sdkB)
  await attachHyperSDK(sdkA, {
    host: '127.0.0.1',
    port: 49839,
    allowLoopback: true,
    discovery: new MemoryDiscovery(bus)
  })
  await attachHyperSDK(sdkB, {
    host: '127.0.0.1',
    port: 49840,
    allowLoopback: true,
    discovery: new MemoryDiscovery(bus)
  })

  const topic = randomBytes(32)
  const connectionA = once(sdkA.swarm, 'connection')
  const connectionB = once(sdkB.swarm, 'connection')
  sdkA.join(topic)
  sdkB.join(topic)

  const [[socketA, infoA], [socketB, infoB]] = await Promise.all([connectionA, connectionB])
  socketA.on('error', () => {})
  socketB.on('error', () => {})
  assert.deepEqual(infoA.topics, [topic])
  assert.deepEqual(infoB.topics, [topic])
  assert.equal(sdkA.localSwarm.keyPair, sdkA.swarm.keyPair)
  assert.equal(sdkB.localSwarm.keyPair, sdkB.swarm.keyPair)
})

function asService (record) {
  return {
    ...record,
    referer: { address: '127.0.0.1' },
    addresses: ['127.0.0.1']
  }
}
