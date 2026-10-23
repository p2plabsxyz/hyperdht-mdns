'use strict'

const { EventEmitter } = require('events')
const test = require('node:test')
const assert = require('node:assert/strict')
const { attachHyperSDK } = require('..')

class FakeSession {
  constructor (topic) {
    this.topic = topic
    this.destroyed = false
  }

  refresh () { return Promise.resolve(true) }
  flushed () { return Promise.resolve(true) }
  destroy () { this.destroyed = true; return Promise.resolve() }
}

class FakeLAN extends EventEmitter {
  constructor () {
    super()
    this.joined = []
    this.joinOpts = []
    this.sessions = []
    this.left = []
    this.closed = false
    this.destroyed = false
    this.suspended = false
  }

  ready () { return Promise.resolve() }
  join (topic, opts) {
    assert.equal(Buffer.isBuffer(topic), true)
    assert.equal(topic.length, 32)
    const session = new FakeSession(topic)
    this.joined.push(topic)
    this.joinOpts.push(opts)
    this.sessions.push(session)
    return session
  }

  leave (topic) { this.left.push(topic); return Promise.resolve() }
  flush () { this.flushed = true; return Promise.resolve(true) }
  suspend () { this.suspended = true; return Promise.resolve() }
  resume () { this.suspended = false; return Promise.resolve() }
  destroy () {
    this.closed = true
    this.destroyed = true
    return Promise.resolve()
  }
}

class FakeSDK {
  constructor () {
    this.globalSessions = []
    this.swarm = new EventEmitter()
    this.swarm.keyPair = { publicKey: Buffer.alloc(32, 1) }
    this.swarm.flush = () => Promise.reject(new Error('offline'))
    this.swarm.suspend = () => { this.globalSuspended = true; return Promise.resolve() }
    this.swarm.resume = () => { this.globalSuspended = false; return Promise.resolve() }
  }

  join (topic) {
    const session = new FakeSession(topic)
    this.globalSessions.push(session)
    return session
  }

  // As hyper-sdk's: join() before the first await.
  async joinCore (core, opts = {}) {
    if (core.discovery) return
    core.discovery = this.join(core.discoveryKey, opts)
  }

  // As hyper-sdk's: a drive already open comes from the cache, with no join.
  async getDrive (id) {
    if (!this.drives) this.drives = new Map()
    let drive = this.drives.get(id)
    if (!drive) {
      drive = { core: { writable: false, discoveryKey: Buffer.alloc(32, id) } }
      this.drives.set(id, drive)
      await this.joinCore(drive.core)
    }
    return drive
  }

  leave () { return Promise.resolve() }
  ready () { return Promise.resolve() }
  suspend () { return Promise.resolve() }
  resume () { return Promise.resolve() }
  close () { this.closed = true; return Promise.resolve() }
  makeTopicKey () { return Buffer.alloc(32, 9) }
}

test('attaches LAN joins, connections and lifecycle to hyper-sdk', async () => {
  const sdk = new FakeSDK()
  const lan = new FakeLAN()
  await attachHyperSDK(sdk, { lan })

  const topic = Buffer.alloc(32, 2)
  const discovery = sdk.join(topic)
  assert.deepEqual(lan.joined, [topic])
  assert.equal(await discovery.flushed(), true)

  const connection = new EventEmitter()
  const received = new Promise(resolve => sdk.swarm.once('connection', (...args) => resolve(args)))
  lan.emit('connection', connection, { topics: [topic], lan: true })
  assert.deepEqual(await received, [connection, { topics: [topic], lan: true }])

  assert.equal(await sdk.swarm.flush(), true)
  await sdk.setLANOnly(true)
  assert.equal(sdk.globalSuspended, true)
  await sdk.setLANOnly(false)
  assert.equal(sdk.globalSuspended, false)
  await sdk.suspend()
  assert.equal(lan.suspended, true)
  await sdk.resume()
  assert.equal(lan.suspended, false)

  await discovery.destroy()
  assert.equal(sdk.globalSessions[0].destroyed, true)
  await sdk.close()
  assert.equal(lan.closed, true)
  assert.equal(sdk.closed, true)
})

test('restores active topics after destroy and reattach', async () => {
  const sdk = new FakeSDK()
  const first = new FakeLAN()
  const second = new FakeLAN()
  await attachHyperSDK(sdk, { lan: first })

  const topic = Buffer.alloc(32, 4)
  const discovery = sdk.join(topic, { server: true, client: true })
  await first.destroy()
  await attachHyperSDK(sdk, { lan: second })

  assert.deepEqual(second.joined, [topic])
  assert.equal(discovery.local, second.sessions[0])

  await discovery.destroy()
  assert.equal(second.sessions[0].destroyed, true)
})

test('a drive opened to read is looked up on the LAN, not announced, and left after a while', async () => {
  const sdk = new FakeSDK()
  const lan = new FakeLAN()
  await attachHyperSDK(sdk, { lan, coreTopicTTL: 50 })

  const reading = { writable: false, discoveryKey: Buffer.alloc(32, 5) }
  await sdk.joinCore(reading, { server: true, client: true })
  assert.deepEqual(lan.joinOpts[0], { server: false, client: true })

  const writing = { writable: true, discoveryKey: Buffer.alloc(32, 6) }
  await sdk.joinCore(writing, { server: true, client: true })
  assert.deepEqual(lan.joinOpts[1], { server: true, client: true })

  // A plain join, such as a room, goes out as asked.
  sdk.join(Buffer.alloc(32, 7), { server: true, client: true })
  assert.deepEqual(lan.joinOpts[2], { server: true, client: true })

  await new Promise((resolve) => setTimeout(resolve, 120))
  assert.equal(lan.sessions[0].destroyed, true, 'the read-only drive left the LAN')
  assert.equal(lan.sessions[1].destroyed, false)
  assert.equal(lan.sessions[2].destroyed, false)
  assert.equal(sdk.globalSessions[0].destroyed, false, 'and stays on the internet')
  assert.equal(await reading.discovery.flushed(), true)
})

test('a drive in use stays on the LAN, and one opened after it left is looked for again', async () => {
  const sdk = new FakeSDK()
  const lan = new FakeLAN()
  await attachHyperSDK(sdk, { lan, coreTopicTTL: 80 })

  const drive = await sdk.getDrive(8)
  assert.equal(lan.sessions.length, 1)
  // Opened every 30 ms, as a page does on each request, for twice the time.
  for (let i = 0; i < 6; i++) {
    await sleep(30)
    assert.equal(await sdk.getDrive(8), drive)
  }
  assert.equal(lan.sessions[0].destroyed, false, 'a drive in use keeps its LAN lookup')

  await sleep(160)
  assert.equal(lan.sessions[0].destroyed, true, 'left once nobody opened it for a while')

  assert.equal(await sdk.getDrive(8), drive)
  assert.equal(lan.sessions.length, 2, 'opening it again looks for it again')
  assert.deepEqual(lan.joinOpts[1], { server: false, client: true })
  assert.equal(drive.core.discovery.local, lan.sessions[1])
  assert.equal(drive.core.discovery.localExpired, false)

  await sleep(160)
  assert.equal(lan.sessions[1].destroyed, true, 'and it leaves again when not opened')
  assert.equal(sdk.globalSessions[0].destroyed, false, 'the internet lookup is untouched')
  await drive.core.discovery.destroy()
  assert.equal(sdk.globalSessions[0].destroyed, true)
})

test('the LAN instance gets a key of its own, never the SDK network key', async (t) => {
  const MemoryAdapter = require('../test-utils/memory-adapter')
  const sdk = new FakeSDK()
  sdk.swarm.keyPair = require('hyperdht').keyPair()
  const lan = await attachHyperSDK(sdk, { host: '127.0.0.1', port: 21590, allowLoopback: true, adapter: new MemoryAdapter(new Set()) })
  t.after(() => lan.destroy())

  assert.equal(sdk.localSwarm, lan)
  assert.equal(lan.ephemeral, true)
  assert.equal(lan.keyPair.publicKey.equals(sdk.swarm.keyPair.publicKey), false)
})

function sleep (ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
