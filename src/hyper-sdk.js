'use strict'

const HyperswarmLAN = require('./hyperswarm-lan')

const ATTACHED = Symbol.for('hyperswarm-lan.hyper-sdk')

async function attachHyperSDK (sdk, opts = {}) {
  assertSDK(sdk)
  if (sdk[ATTACHED]) return sdk[ATTACHED]

  const { lan: suppliedLAN, lanOnly = false, ...lanOpts } = opts
  const lan = suppliedLAN || new HyperswarmLAN({
    ...lanOpts,
    keyPair: sdk.swarm.keyPair
  })
  sdk[ATTACHED] = lan
  sdk.localSwarm = lan

  const original = {
    close: sdk.close.bind(sdk),
    join: sdk.join.bind(sdk),
    leave: sdk.leave.bind(sdk),
    ready: sdk.ready.bind(sdk),
    resume: sdk.resume.bind(sdk),
    suspend: sdk.suspend.bind(sdk),
    flush: sdk.swarm.flush.bind(sdk.swarm)
  }

  lan.on('connection', (socket, peerInfo) => {
    // Keep existing SDK and application listeners working. hyper-sdk's own
    // listener replicates Corestore before later listeners receive the socket.
    sdk.swarm.emit('connection', socket, peerInfo)
  })

  sdk.join = (topic, joinOpts) => {
    const localTopic = normalizeTopic(sdk, topic)
    const globalSession = original.join(topic, joinOpts)
    let localSession

    try {
      localSession = lan.join(localTopic, joinOpts)
    } catch (error) {
      globalSession.destroy().catch(() => {})
      throw error
    }

    return new CombinedDiscovery(globalSession, localSession)
  }

  sdk.leave = async (topic) => {
    const localTopic = normalizeTopic(sdk, topic)
    const results = await Promise.allSettled([
      original.leave(topic),
      lan.leave(localTopic)
    ])
    throwFirstRejection(results)
  }

  sdk.ready = () => Promise.all([original.ready(), lan.ready()])
  sdk.suspend = (suspendOpts) => Promise.all([
    original.suspend(suspendOpts),
    lan.suspend(suspendOpts)
  ])
  sdk.resume = (resumeOpts) => Promise.all([
    original.resume(resumeOpts),
    lan.resume(resumeOpts)
  ])

  sdk.swarm.flush = (...args) => {
    // Public DHT failure must not block a LAN-only application. The global
    // flush continues in the background when internet access is unavailable.
    original.flush(...args).catch(() => {})
    return lan.flush()
  }

  let isLANOnly = false
  sdk.setLANOnly = async (enabled = true) => {
    enabled = !!enabled
    if (enabled === isLANOnly) return
    if (enabled) await sdk.swarm.suspend()
    else await sdk.swarm.resume()
    isLANOnly = enabled
  }

  let closing = null
  sdk.close = () => {
    if (!closing) {
      closing = lan.destroy().then(
        () => original.close(),
        () => original.close()
      )
    }
    return closing
  }

  await lan.ready()
  if (lanOnly) await sdk.setLANOnly(true)
  return lan
}

class CombinedDiscovery {
  constructor (globalSession, localSession) {
    this.global = globalSession
    this.local = localSession
    this.topic = localSession.topic || globalSession.topic
  }

  async refresh (opts) {
    const results = await Promise.allSettled([
      this.global.refresh(opts),
      this.local.refresh(opts)
    ])
    return results.some(result => result.status === 'fulfilled' && result.value !== false)
  }

  flushed () {
    this.global.flushed().catch(() => {})
    return this.local.flushed()
  }

  async destroy () {
    const results = await Promise.allSettled([
      this.global.destroy(),
      this.local.destroy()
    ])
    throwFirstRejection(results)
  }
}

function normalizeTopic (sdk, topic) {
  if (typeof topic !== 'string') return topic
  if (typeof sdk.makeTopicKey !== 'function') {
    throw new TypeError('The SDK must expose makeTopicKey() for string topics')
  }
  return sdk.makeTopicKey(topic)
}

function assertSDK (sdk) {
  if (!sdk || !sdk.swarm || !sdk.swarm.keyPair) {
    throw new TypeError('A hyper-sdk instance with a swarm keyPair is required')
  }
  for (const method of ['close', 'join', 'leave', 'ready', 'resume', 'suspend']) {
    if (typeof sdk[method] !== 'function') throw new TypeError(`sdk.${method}() is required`)
  }
  if (typeof sdk.swarm.flush !== 'function') throw new TypeError('sdk.swarm.flush() is required')
}

function throwFirstRejection (results) {
  const rejected = results.find(result => result.status === 'rejected')
  if (rejected) throw rejected.reason
}

module.exports = attachHyperSDK
module.exports.CombinedDiscovery = CombinedDiscovery
