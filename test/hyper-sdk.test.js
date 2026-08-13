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
    this.left = []
    this.closed = false
    this.suspended = false
  }

  ready () { return Promise.resolve() }
  join (topic) { this.joined.push(topic); return new FakeSession(topic) }
  leave (topic) { this.left.push(topic); return Promise.resolve() }
  flush () { this.flushed = true; return Promise.resolve(true) }
  suspend () { this.suspended = true; return Promise.resolve() }
  resume () { this.suspended = false; return Promise.resolve() }
  destroy () { this.closed = true; return Promise.resolve() }
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
