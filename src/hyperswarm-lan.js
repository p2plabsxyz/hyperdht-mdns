'use strict'

const { EventEmitter } = require('events')
const HyperDHT = require('hyperdht')
const Hyperswarm = require('hyperswarm')
const BonjourAdapter = require('./bonjour-adapter')
const { selectLocalIPv4, serviceIPv4 } = require('./network')
const {
  MAX_ADVERTISED_TOPICS,
  SERVICE_PROTOCOL,
  SERVICE_TYPE,
  createRecords,
  parseRecord,
  topicToken
} = require('./record')

const DEFAULT_PORT = 49799
const PEER_REFRESH_INTERVAL = 30_000
const RECONNECT_INITIAL_DELAY = 250
const RECONNECT_MAX_DELAY = 30_000

class HyperDHTmDNS extends EventEmitter {
  constructor (opts = {}) {
    super()

    this.destroyed = false
    this.suspended = false
    this._allowLoopback = opts.allowLoopback === true
    this._autoHost = !opts.host
    this.host = opts.host || selectLocalIPv4(undefined, this._allowLoopback)
    this.port = opts.port === undefined ? DEFAULT_PORT : opts.port
    this._ownsSwarm = !opts.swarm
    this._destroySwarm = this._ownsSwarm && opts.destroySwarm !== false
    this._direct = opts.eager !== false
    this._joinedTopics = new Map()
    this._knownPeers = new Map()
    this._peerRecords = new Map()
    this._peerTopics = new Map()
    this._directConnections = new Map()
    this._connectionInfo = new Map()
    this._reconnectAttempts = new Map()
    this._reconnectTimers = new Map()
    this._advertising = false
    this._advertisedSignature = null
    this._advertisementQueue = Promise.resolve()

    if (opts.swarm) {
      this.swarm = opts.swarm
      this.dht = opts.dht || opts.swarm.dht
      this.keyPair = opts.keyPair || opts.swarm.keyPair
    } else {
      this.keyPair = opts.keyPair || HyperDHT.keyPair(opts.seed)
      this.dht = opts.dht || HyperDHT.bootstrapper(this.port, this.host, {
        ...opts.dhtOptions,
        bootstrap: [],
        keyPair: this.keyPair
      })
      this.swarm = new Hyperswarm({
        ...opts.swarmOptions,
        keyPair: this.keyPair,
        dht: this.dht
      })
    }

    if (!this.dht) throw new TypeError('A supplied swarm must expose its dht instance')
    if (!this.keyPair || !Buffer.isBuffer(this.keyPair.publicKey)) {
      throw new TypeError('The swarm keyPair must expose a publicKey Buffer')
    }

    this.adapter = opts.adapter || new BonjourAdapter(opts.mdnsOptions)
    assertAdapter(this.adapter)
    this._browser = null
    this._advertisement = null
    this._advertisements = []
    this._onServiceDiscovered = (service) => {
      this._handleService(service).catch((error) => this.emit('warning', error))
    }
    this._onConnection = (socket, peerInfo) => this._handleSwarmConnection(socket, peerInfo)
    this._onUpdate = () => this.emit('update')
    this._onDiscoveryError = (error) => this.emit('error', error)
    this._onDiscoveryDown = (service) => {
      if (this._handleServiceDown(service)) this.emit('peer-down', service)
    }

    this.swarm.on('connection', this._onConnection)
    this.swarm.on('update', this._onUpdate)
    this._opening = this._open()
  }

  get connections () {
    const connections = new Set(this.swarm.connections || [])
    for (const socket of this._directConnections.values()) connections.add(socket)
    return connections
  }

  get peers () {
    return this.swarm.peers
  }

  async _open () {
    try {
      await this.dht.fullyBootstrapped()
    } catch (cause) {
      if (cause?.code === 'EADDRINUSE') {
        throw new Error(
          `LAN DHT port ${this.port} is already in use. Choose a different fixed port for another local instance.`,
          { cause }
        )
      }
      throw cause
    }
    if (this.destroyed) return

    await this.swarm.listen()
    if (this.destroyed) return

    const address = this.dht.address()
    if (address && address.port) this.port = address.port

    const records = this._createRecords()
    await this._startDiscovery(records)
    if (this.destroyed) return

    this._advertisedSignature = recordSignature(records)
    this._advertising = true
    await this._updateAdvertisement()
    this.emit('ready')
  }

  ready () {
    return this._opening
  }

  listen () {
    return this.ready()
  }

  join (topic, opts) {
    assertTopic(topic)
    this._retainTopic(topic)

    let session
    try {
      session = this.swarm.join(topic, opts)
    } catch (error) {
      this._releaseTopic(topic)
      throw error
    }

    const destroy = session.destroy.bind(session)
    let active = true
    session.destroy = async (...args) => {
      if (active) {
        active = false
        this._releaseTopic(topic)
      }
      return destroy(...args)
    }

    return session
  }

  async leave (topic) {
    assertTopic(topic)
    this._joinedTopics.delete(topic.toString('hex'))
    this._topicsChanged()
    return this.swarm.leave(topic)
  }

  joinPeer (publicKey) {
    return this.swarm.joinPeer(publicKey)
  }

  leavePeer (publicKey) {
    return this.swarm.leavePeer(publicKey)
  }

  flush () {
    return this.swarm.flush()
  }

  topics () {
    return this.swarm.topics()
  }

  status (topic) {
    return this.swarm.status(topic)
  }

  /**
   * Track a joined topic.
   *
   * Every joined topic is kept, however many there are: incoming peers are
   * matched against this set, so a topic that does not fit in the advertisement
   * is still discoverable when the peer on the other side advertises it. The
   * record decides for itself how many it can carry — running out of room in a
   * multicast packet is not a reason to fail the caller's join.
   */
  _retainTopic (topic) {
    const id = topic.toString('hex')
    const existing = this._joinedTopics.get(id)

    if (existing) existing.refs++
    else this._joinedTopics.set(id, { topic: Buffer.from(topic), token: topicToken(topic), refs: 1 })

    this._topicsChanged()
  }

  _releaseTopic (topic) {
    const id = topic.toString('hex')
    const existing = this._joinedTopics.get(id)
    if (!existing) return

    if (--existing.refs === 0) this._joinedTopics.delete(id)
    this._topicsChanged()
  }

  _topicsChanged () {
    this._queueAdvertisementUpdate()

    for (const peer of this._knownPeers.values()) {
      this._considerPeer(peer).catch((error) => this.emit('warning', error))
    }
  }

  _createRecords () {
    return createRecords({
      peerKey: this.keyPair.publicKey,
      port: this.port,
      topics: [...this._joinedTopics.values()].map(entry => entry.topic)
    })
  }

  _queueAdvertisementUpdate () {
    if (!this._advertising || this.suspended || this.destroyed) return

    this._advertisementQueue = this._advertisementQueue
      .then(() => this._updateAdvertisement())
      .catch((error) => this.emit('warning', error))
  }

  async _updateAdvertisement () {
    if (!this._advertising || this.suspended || this.destroyed) return

    const records = this._createRecords()
    const signature = recordSignature(records)
    if (signature === this._advertisedSignature) return
    const previous = this._advertisements
    const advertisements = await this._advertiseRecords(records)
    if (!this._advertising || this.suspended || this.destroyed) {
      await stopHandles(advertisements)
      return
    }

    this._advertisements = advertisements
    this._advertisement = advertisements[0] || null
    this._advertisedSignature = signature
    await stopHandles(previous)
  }

  async _handleService (service) {
    if (this.destroyed || this.suspended) return

    const record = parseRecord(service)
    const host = serviceIPv4(service)
    if (!record || !host) return
    if (record.peerKey.equals(this.keyPair.publicKey)) return

    const id = record.peerKey.toString('hex')
    let advertised = this._peerRecords.get(id)
    if (!advertised || advertised.generation !== record.generation) {
      advertised = {
        generation: record.generation,
        shards: new Map()
      }
      this._peerRecords.set(id, advertised)
    }
    advertised.shards.set(record.shard, record)

    const previous = this._knownPeers.get(id)
    const peer = {
      host,
      port: record.port,
      publicKey: record.peerKey,
      tokens: aggregateTokens(advertised.shards),
      reachable: previous?.reachable === true &&
        previous.host === host && previous.port === record.port,
      lastSignature: previous?.lastSignature || null,
      lastSeen: previous?.lastSeen || 0
    }

    this._knownPeers.set(id, peer)
    await this._considerPeer(peer)
  }

  async _considerPeer (peer, force = false) {
    if (this.destroyed || this.suspended) return

    const id = peer.publicKey.toString('hex')
    const matchedTopics = this._matchingTopics(peer.tokens)
    const signature = `${peer.host}:${peer.port}|${peer.tokens.join(',')}|${this._localTokenSignature()}`
    const now = Date.now()

    this._peerTopics.set(id, matchedTopics)
    this._updateConnectionTopics(id, matchedTopics)

    if (matchedTopics.length === 0) {
      this._cancelReconnect(id)
      this._disconnectDirect(id)
    }

    const shouldAnnounce = signature !== peer.lastSignature ||
      now - peer.lastSeen >= PEER_REFRESH_INTERVAL

    if (shouldAnnounce) {
      peer.lastSignature = signature
      peer.lastSeen = now
      this.emit('peer', visiblePeer(peer, matchedTopics))
    }

    if (!force && !shouldAnnounce) {
      if (peer.reachable && matchedTopics.length > 0) {
        this._connectDirect(peer, matchedTopics)
      }
      return
    }

    if (!peer.reachable || force) {
      this.dht.addNode(peer)

      try {
        await this.dht.ping(peer, { retry: false })
      } catch (error) {
        peer.reachable = false
        error.message = `Could not reach discovered LAN DHT node ${peer.host}:${peer.port}: ${error.message}`
        this.emit('warning', error)
        this._scheduleReconnect(id)
        return
      }

      peer.reachable = true
      this.dht.refresh()

      const discoveries = [...this.swarm.topics()]
      await refreshAll(discoveries)
    }

    if (this._direct && matchedTopics.length > 0) this._connectDirect(peer, matchedTopics)
    if (shouldAnnounce || force) this.emit('peer-reachable', visiblePeer(peer, matchedTopics))
  }

  _handleServiceDown (service) {
    const record = parseRecord(service)
    if (!record || record.peerKey.equals(this.keyPair.publicKey)) return false

    const id = record.peerKey.toString('hex')
    const advertised = this._peerRecords.get(id)
    if (!advertised || advertised.generation !== record.generation) return false

    const current = advertised.shards.get(record.shard)
    if (!current || tokenSignature(current.tokens) !== tokenSignature(record.tokens)) return false
    advertised.shards.delete(record.shard)

    if (advertised.shards.size > 0) {
      const peer = this._knownPeers.get(id)
      if (peer) {
        peer.tokens = aggregateTokens(advertised.shards)
        this._considerPeer(peer).catch((error) => this.emit('warning', error))
      }
      return false
    }

    this._peerRecords.delete(id)
    const peer = this._knownPeers.get(id)
    if (!peer) return false
    this._knownPeers.delete(id)
    this._peerTopics.delete(id)
    this._cancelReconnect(id)
    this._disconnectDirect(id)
    return true
  }

  _matchingTopics (tokens) {
    const local = new Map()
    for (const entry of this._joinedTopics.values()) {
      local.set(entry.token, entry.topic)
    }

    const matched = []
    for (const token of tokens) {
      if (local.has(token)) matched.push(Buffer.from(local.get(token)))
    }
    return matched
  }

  _localTokenSignature () {
    return [...this._joinedTopics.values()]
      .map(entry => entry.token)
      .sort()
      .join(',')
  }

  _handleSwarmConnection (socket, peerInfo) {
    const publicKey = socket.remotePublicKey || peerInfo.publicKey
    if (!publicKey) {
      if (this._ownsSwarm) socket.destroy()
      return
    }

    const id = publicKey.toString('hex')
    const discoveredTopics = Array.isArray(peerInfo.topics) ? peerInfo.topics : []
    const topics = discoveredTopics.length > 0
      ? discoveredTopics.filter(topic => this._joinedTopics.has(topic.toString('hex')))
      : (this._peerTopics.get(id) || [])

    if (topics.length === 0) {
      if (this._ownsSwarm) socket.destroy()
      return
    }

    this._emitConnection(socket, {
      ...peerInfo,
      publicKey,
      topics,
      lan: true
    }, discoveredTopics.length === 0)
  }

  _connectDirect (peer, topics) {
    if (Buffer.compare(this.keyPair.publicKey, peer.publicKey) > 0) return

    const id = peer.publicKey.toString('hex')
    if (this._directConnections.has(id)) return

    const relayAddresses = [{ host: peer.host, port: peer.port }]
    const socket = this.dht.connect(peer.publicKey, {
      keyPair: this.keyPair,
      relayAddresses
    })
    this._directConnections.set(id, socket)

    socket.once('open', () => {
      this._cancelReconnect(id)
      this._emitConnection(socket, {
        publicKey: peer.publicKey,
        relayAddresses,
        topics,
        client: true,
        lan: true
      }, true)
    })
    socket.on('error', (cause) => {
      if (this.destroyed || this.suspended) return
      const error = new Error(`Direct LAN connection to ${peer.host}:${peer.port} failed`, { cause })
      this.emit('warning', error)
    })
    socket.once('close', () => {
      if (this._directConnections.get(id) === socket) this._directConnections.delete(id)
      if (this._connectionInfo.get(id)?.socket === socket) this._connectionInfo.delete(id)
      this.emit('update')
      this._scheduleReconnect(id)
    })
  }

  _emitConnection (socket, info, direct) {
    const id = info.publicKey.toString('hex')
    const existing = this._connectionInfo.get(id)
    if (existing && existing.socket !== socket && !existing.socket.destroyed) {
      return socket.destroy()
    }

    if (direct) this._directConnections.set(id, socket)
    this._connectionInfo.set(id, { socket, info })
    this._cancelReconnect(id)
    socket.once('close', () => {
      if (this._directConnections.get(id) === socket) this._directConnections.delete(id)
      if (this._connectionInfo.get(id)?.socket === socket) this._connectionInfo.delete(id)
      this._scheduleReconnect(id)
    })

    this.emit('connection', socket, info)
    this.emit('update')
  }

  _updateConnectionTopics (id, topics) {
    const active = this._connectionInfo.get(id)
    if (!active) return
    active.info.topics = topics
    this.emit('topics-change', active.socket, active.info)
  }

  _disconnectDirect (id) {
    const direct = this._directConnections.get(id)
    const active = this._connectionInfo.get(id)?.socket
    if (direct) direct.destroy()
    if (active && active !== direct) active.destroy()
  }

  _scheduleReconnect (id) {
    if (!this._canReconnect(id) || this._reconnectTimers.has(id)) return

    const attempt = this._reconnectAttempts.get(id) || 0
    const cappedAttempt = Math.min(attempt, 16)
    const delay = Math.min(RECONNECT_INITIAL_DELAY * (2 ** cappedAttempt), RECONNECT_MAX_DELAY)
    this._reconnectAttempts.set(id, Math.min(cappedAttempt + 1, 16))

    const timer = setTimeout(() => {
      this._reconnectTimers.delete(id)
      if (!this._canReconnect(id)) return

      const peer = this._knownPeers.get(id)
      peer.reachable = false
      this._considerPeer(peer, true).catch((error) => {
        this.emit('warning', error)
        this._scheduleReconnect(id)
      })
    }, delay)
    timer.unref?.()
    this._reconnectTimers.set(id, timer)
  }

  _canReconnect (id) {
    if (this.destroyed || this.suspended || !this._direct) return false

    const peer = this._knownPeers.get(id)
    if (!peer || Buffer.compare(this.keyPair.publicKey, peer.publicKey) > 0) return false
    if (this._matchingTopics(peer.tokens).length === 0) return false

    const direct = this._directConnections.get(id)
    const active = this._connectionInfo.get(id)?.socket
    return (!direct || direct.destroyed) && (!active || active.destroyed)
  }

  _cancelReconnect (id) {
    const timer = this._reconnectTimers.get(id)
    if (timer) clearTimeout(timer)
    this._reconnectTimers.delete(id)
    this._reconnectAttempts.delete(id)
  }

  _cancelAllReconnects () {
    for (const timer of this._reconnectTimers.values()) clearTimeout(timer)
    this._reconnectTimers.clear()
    this._reconnectAttempts.clear()
  }

  async suspend (opts) {
    if (this.suspended || this.destroyed) return
    await this.ready()
    this.suspended = true
    this._advertising = false

    await this._advertisementQueue
    await this._stopDiscovery()
    this._cancelAllReconnects()
    for (const peer of this._knownPeers.values()) peer.reachable = false
    for (const socket of this._directConnections.values()) socket.destroy()
    this._directConnections.clear()
    await this.swarm.suspend(opts)
  }

  async resume (opts) {
    if (!this.suspended || this.destroyed) return

    let freshHost = this.host
    if (this._autoHost) {
      try {
        freshHost = selectLocalIPv4(undefined, this._allowLoopback)
      } catch (error) {
        this.emit('warning', error)
      }
    }

    if (freshHost && freshHost !== this.host) {
      const error = new Error(
        `The LAN interface changed from ${this.host} to ${freshHost}; recreate the LAN DHT instance to bind the new address.`
      )
      error.code = 'ERR_LAN_INTERFACE_CHANGED'
      if (this.listenerCount('error') > 0) this.emit('error', error)
      throw error
    }

    await this.swarm.resume(opts)
    this.suspended = false
    const records = this._createRecords()
    try {
      await this._startDiscovery(records)
    } catch (error) {
      this.suspended = true
      await this.swarm.suspend(opts).catch(() => {})
      throw error
    }
    this._advertisedSignature = recordSignature(records)
    this._advertising = true

    for (const peer of this._knownPeers.values()) {
      peer.reachable = false
      this._considerPeer(peer, true).catch((error) => this.emit('warning', error))
    }
  }

  async destroy () {
    if (this.destroyed) return
    this.destroyed = true

    try {
      await this._opening
    } catch {
      // Startup errors remain observable through ready(); teardown still proceeds.
    }

    this._advertising = false
    this._cancelAllReconnects()
    this.swarm.removeListener('connection', this._onConnection)
    this.swarm.removeListener('update', this._onUpdate)
    await this._advertisementQueue
    await this._stopDiscovery()
    for (const socket of this._directConnections.values()) socket.destroy()
    this._directConnections.clear()
    if (this._destroySwarm) await this.swarm.destroy()

    this.emit('close')
  }

  async _startDiscovery (records) {
    const browser = await this.adapter.browse({
      type: SERVICE_TYPE,
      protocol: SERVICE_PROTOCOL
    }, {
      onService: this._onServiceDiscovered,
      onServiceDown: this._onDiscoveryDown,
      onError: this._onDiscoveryError
    })
    assertHandle(browser, 'browse')

    let advertisements
    try {
      advertisements = await this._advertiseRecords(records)
    } catch (error) {
      await stopHandle(browser)
      throw error
    }

    this._browser = browser
    this._advertisements = advertisements
    this._advertisement = advertisements[0] || null
  }

  async _advertiseRecords (records) {
    const advertisements = []
    try {
      for (const record of records) {
        const advertisement = await this.adapter.advertise(record, {
          onError: this._onDiscoveryError
        })
        assertHandle(advertisement, 'advertise')
        advertisements.push(advertisement)
      }
      return advertisements
    } catch (error) {
      await stopHandles(advertisements)
      throw error
    }
  }

  async _stopDiscovery () {
    const browser = this._browser
    const advertisements = this._advertisements
    this._browser = null
    this._advertisement = null
    this._advertisements = []
    await Promise.all([stopHandle(browser), stopHandles(advertisements)])
  }
}

HyperDHTmDNS.DEFAULT_PORT = DEFAULT_PORT
HyperDHTmDNS.MAX_ADVERTISED_TOPICS = MAX_ADVERTISED_TOPICS

module.exports = HyperDHTmDNS

function assertTopic (topic) {
  if (!Buffer.isBuffer(topic) || topic.byteLength !== 32) {
    throw new TypeError('topic must be a 32-byte Buffer')
  }
}

function assertAdapter (adapter) {
  if (!adapter || typeof adapter.advertise !== 'function' || typeof adapter.browse !== 'function') {
    throw new TypeError('adapter must implement advertise(record, handlers) and browse(query, handlers)')
  }
}

function assertHandle (handle, method) {
  if (!handle || typeof handle.stop !== 'function') {
    throw new TypeError(`adapter.${method}() must return a handle with stop()`)
  }
}

function stopHandle (handle) {
  return handle ? handle.stop() : Promise.resolve()
}

function recordSignature (records) {
  return JSON.stringify(records.map(record => [record.name, record.txt]))
}

function visiblePeer (peer, topics) {
  const visible = { ...peer, topics }
  delete visible.lastSignature
  delete visible.lastSeen
  return visible
}

function refreshAll (discoveries) {
  return Promise.allSettled(discoveries.map((discovery) => discovery.refresh()))
}

function stopHandles (handles) {
  return Promise.all((handles || []).map(stopHandle))
}

function aggregateTokens (shards) {
  const tokens = new Set()
  for (const record of shards.values()) {
    for (const token of record.tokens) tokens.add(token)
  }
  return [...tokens].sort()
}

function tokenSignature (tokens) {
  return tokens.slice().sort().join(',')
}
