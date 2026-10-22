'use strict'

const HyperDHTmDNS = require('./hyperswarm-lan')

const ATTACHED = Symbol.for('hyperdht-mdns.hyper-sdk')
const ATTACHMENT_STATE = Symbol.for('hyperdht-mdns.hyper-sdk.state')
// A drive opened to read is looked for on the local network until it has not
// been opened for this long, then left there. The internet join is untouched.
const CORE_TOPIC_TTL = 10 * 60_000

/**
 * Mirror an SDK's joins on the local network.
 *
 * The LAN instance gets a key pair of its own, made up for this run, never
 * the SDK's: that one is the device's long-term key (and PeerChat's id), and
 * would let anyone on the network link the device across networks and days.
 * Connections from the LAN arrive on sdk.swarm's 'connection' event with
 * info.lan and info.ephemeral set; an application that needs to know who is
 * on the other end asks for proof inside the channel (createIdentityProof).
 *
 * What is announced: topics joined with sdk.join, such as rooms and private
 * sync, as asked. Drives this device writes, as asked. Drives opened only to
 * read are looked up, not announced, and left on the LAN once they have not
 * been opened for coreTopicTTL; opening one again looks for it again.
 */
async function attachHyperSDK (sdk, opts = {}) {
  assertSDK(sdk)
  if (sdk[ATTACHED] && !sdk[ATTACHED].destroyed) return sdk[ATTACHED]

  const state = sdk[ATTACHMENT_STATE] || { discoveries: new Set(), coreTopicTTL: CORE_TOPIC_TTL }
  const isReattach = !!sdk[ATTACHMENT_STATE]

  const { lan: suppliedLAN, lanOnly = false, coreTopicTTL, ...lanOpts } = opts
  if (coreTopicTTL !== undefined) state.coreTopicTTL = coreTopicTTL
  const lan = suppliedLAN || new HyperDHTmDNS(lanOpts)
  sdk[ATTACHED] = lan
  sdk.localSwarm = lan

  if (!isReattach) {
    const original = {
      close: sdk.close.bind(sdk),
      join: sdk.join.bind(sdk),
      joinCore: typeof sdk.joinCore === 'function' ? sdk.joinCore.bind(sdk) : null,
      leave: sdk.leave.bind(sdk),
      ready: sdk.ready.bind(sdk),
      resume: sdk.resume.bind(sdk),
      suspend: sdk.suspend.bind(sdk),
      flush: sdk.swarm.flush.bind(sdk.swarm)
    }

    // hyper-sdk's joinCore calls join() before its first await, so the core
    // a join is for is known here.
    let joiningCore = null
    if (original.joinCore) {
      sdk.joinCore = (core, joinOpts) => {
        joiningCore = core
        try {
          return original.joinCore(core, joinOpts)
        } finally {
          joiningCore = null
        }
      }
    }

    sdk.join = (topic, joinOpts) => {
      const core = joiningCore
      joiningCore = null
      const localTopic = normalizeTopic(sdk, topic)
      const globalSession = original.join(topic, joinOpts)
      const lanJoin = lanJoinFor(core, joinOpts, state.coreTopicTTL)
      let localSession

      try {
        localSession = sdk[ATTACHED].join(localTopic, lanJoin.opts)
      } catch (error) {
        globalSession.destroy().catch(() => {})
        throw error
      }

      const discovery = new CombinedDiscovery(
        globalSession,
        localSession,
        localTopic,
        lanJoin,
        () => state.discoveries.delete(discovery)
      )
      state.discoveries.add(discovery)
      return discovery
    }

    // A drive in use is opened again and again (hypercore-fetch opens it on
    // every request), and each time its LAN lookup goes on for longer, or
    // starts again after it ended.
    for (const method of ['get', 'getDrive']) {
      if (typeof sdk[method] !== 'function') continue
      const open = sdk[method].bind(sdk)
      sdk[method] = async (...args) => {
        const opened = await open(...args)
        const discovery = opened?.discovery || opened?.core?.discovery
        if (discovery instanceof CombinedDiscovery) discovery.used(sdk[ATTACHED], state.coreTopicTTL)
        return opened
      }
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
    if (discovery.localExpired) continue
    restoredSessions.push([discovery, lan.join(discovery.topic, discovery.lanJoin.opts)])
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

// How a join goes out on the local network.
function lanJoinFor (core, joinOpts = {}, ttl) {
  if (!core || core.writable) return { opts: joinOpts, expiresAt: 0 }
  return {
    opts: { ...joinOpts, server: false, client: true },
    expiresAt: ttl > 0 ? Date.now() + ttl : 0
  }
}

class CombinedDiscovery {
  constructor (globalSession, localSession, topic, lanJoin, onDestroy) {
    this.global = globalSession
    this.local = localSession
    this.topic = Buffer.from(topic)
    this.lanJoin = lanJoin
    this.joinOpts = lanJoin.opts
    this.destroyed = false
    this.localExpired = false
    this._onDestroy = onDestroy
    this._expiry = null
    if (lanJoin.expiresAt) this._expireLocalAt(lanJoin.expiresAt)
  }

  _expireLocalAt (expiresAt) {
    this._expiry = setTimeout(() => {
      this._expiry = null
      if (this.destroyed) return
      // Opened again meanwhile: wait for the rest.
      if (Date.now() < this.lanJoin.expiresAt) return this._expireLocalAt(this.lanJoin.expiresAt)
      this.localExpired = true
      this.local.destroy().catch(() => {})
    }, Math.max(0, expiresAt - Date.now()))
    this._expiry.unref?.()
  }

  // Opened again: looked for on the LAN for another ttl, and again from now
  // if the lookup had ended.
  used (lan, ttl) {
    if (this.destroyed || !this.lanJoin.expiresAt || !(ttl > 0)) return
    this.lanJoin.expiresAt = Date.now() + ttl
    if (!this.localExpired || !lan || lan.destroyed) return
    this.local = lan.join(this.topic, this.lanJoin.opts)
    this.localExpired = false
    this._expireLocalAt(this.lanJoin.expiresAt)
  }

  replaceLocal (localSession) {
    this.local = localSession
  }

  async refresh (opts) {
    const results = await Promise.allSettled([
      this.global.refresh(opts),
      this.localExpired ? Promise.resolve(false) : this.local.refresh(opts)
    ])
    return results.some(result => result.status === 'fulfilled' && result.value !== false)
  }

  flushed () {
    if (this.localExpired) return this.global.flushed()
    this.global.flushed().catch(() => {})
    return this.local.flushed()
  }

  async destroy () {
    if (this.destroyed) return
    this.destroyed = true
    if (this._expiry) clearTimeout(this._expiry)
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
  if (!sdk || !sdk.swarm) {
    throw new TypeError('A hyper-sdk instance with a swarm is required')
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
module.exports.CORE_TOPIC_TTL = CORE_TOPIC_TTL
