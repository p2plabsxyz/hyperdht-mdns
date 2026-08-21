'use strict'

const HyperDHTmDNS = require('./hyperswarm-lan')

const ATTACHED = Symbol.for('hyperdht-mdns.hyper-sdk')
const ATTACHMENT_STATE = Symbol.for('hyperdht-mdns.hyper-sdk.state')

async function attachHyperSDK (sdk, opts = {}) {
  assertSDK(sdk)
  if (sdk[ATTACHED] && !sdk[ATTACHED].destroyed) return sdk[ATTACHED]

  const state = sdk[ATTACHMENT_STATE] || { discoveries: new Set() }
  const isReattach = !!sdk[ATTACHMENT_STATE]

  const { lan: suppliedLAN, lanOnly = false, ...lanOpts } = opts
  const lan = suppliedLAN || new HyperDHTmDNS({
    ...lanOpts,
    keyPair: sdk.swarm.keyPair
  })
  sdk[ATTACHED] = lan
  sdk.localSwarm = lan

  if (!isReattach) {
    const original = {
      close: sdk.close.bind(sdk),
      join: sdk.join.bind(sdk),
      leave: sdk.leave.bind(sdk),
      ready: sdk.ready.bind(sdk),
      resume: sdk.resume.bind(sdk),
      suspend: sdk.suspend.bind(sdk),
      flush: sdk.swarm.flush.bind(sdk.swarm)
    }

    sdk.join = (topic, joinOpts) => {
      const localTopic = normalizeTopic(sdk, topic)
      const globalSession = original.join(topic, joinOpts)
      let localSession

      try {
        localSession = sdk[ATTACHED].join(localTopic, joinOpts)
      } catch (error) {
        globalSession.destroy().catch(() => {})
        throw error
      }

      const discovery = new CombinedDiscovery(
        globalSession,
        localSession,
        localTopic,
        joinOpts,
        () => state.discoveries.delete(discovery)
      )
      state.discoveries.add(discovery)
      return discovery
    }

    sdk.leave = async (topic) => {
      const localTopic = normalizeTopic(sdk, topic)
      const results = await Promise.allSettled([
        original.leave(topic),
        sdk[ATTACHED].leave(localTopic)
      ])
      for (const discovery of state.discoveries) {
        if (discovery.topic.equals(localTopic)) state.discoveries.delete(discovery)
      }
      throwFirstRejection(results)
    }

    sdk.ready = async () => { await Promise.all([original.ready(), sdk[ATTACHED].ready()]) }
    sdk.suspend = async (suspendOpts) => {
      await Promise.all([original.suspend(suspendOpts), sdk[ATTACHED].suspend(suspendOpts)])
    }
    sdk.resume = async (resumeOpts) => {
      await Promise.all([original.resume(resumeOpts), sdk[ATTACHED].resume(resumeOpts)])
    }

    sdk.swarm.flush = (...args) => {
      // Public DHT failure must not block a LAN-only application. The global
      // flush continues in the background when internet access is unavailable.
      original.flush(...args).catch(() => {})
      return sdk[ATTACHED].flush()
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
        closing = sdk[ATTACHED].destroy().then(
          () => original.close(),
          () => original.close()
        )
      }
      return closing
    }
  }

  lan.on('connection', (socket, peerInfo) => {
    // Keep existing SDK and application listeners working. hyper-sdk's own
    // listener replicates Corestore before later listeners receive the socket.
    sdk.swarm.emit('connection', socket, peerInfo)
  })

  const restoredSessions = []
  for (const discovery of state.discoveries) {
    restoredSessions.push([discovery, lan.join(discovery.topic, discovery.joinOpts)])
  }

  await lan.ready()
  for (const [discovery, localSession] of restoredSessions) {
    if (!state.discoveries.has(discovery) || discovery.destroyed) {
      await localSession.destroy()
    } else {
      discovery.replaceLocal(localSession)
    }
  }
  sdk[ATTACHMENT_STATE] = state
  if (lanOnly && !isReattach) await sdk.setLANOnly(true)
  return lan
}

class CombinedDiscovery {
  constructor (globalSession, localSession, topic, joinOpts, onDestroy) {
    this.global = globalSession
    this.local = localSession
    this.topic = Buffer.from(topic)
    this.joinOpts = joinOpts
    this.destroyed = false
    this._onDestroy = onDestroy
  }

  replaceLocal (localSession) {
    this.local = localSession
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
    if (this.destroyed) return
    this.destroyed = true
    this._onDestroy()
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
