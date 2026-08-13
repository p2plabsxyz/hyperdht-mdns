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
  createRecord,
  parseRecord,
  topicToken
} = require('./record')

const DEFAULT_PORT = 49799
const PEER_REFRESH_INTERVAL = 30_000

class HyperswarmLAN extends EventEmitter {
  constructor (opts = {}) {
    super()

    this.destroyed = false
    this.suspended = false
    this.host = opts.host || selectLocalIPv4(undefined, opts.allowLoopback === true)
    this.port = opts.port === undefined ? DEFAULT_PORT : opts.port
    this._destroySwarm = opts.destroySwarm !== false
    this._direct = opts.eager !== false
    this._joinedTopics = new Map()
    this._knownPeers = new Map()
    this._peerTopics = new Map()
    this._directConnections = new Map()
    this._connectionInfo = new Map()
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
    this._onServiceDiscovered = (service) => {
      this._handleService(service).catch((error) => this.emit('warning', error))
    }
    this._onConnection = (socket, peerInfo) => this._handleSwarmConnection(socket, peerInfo)
    this._onUpdate = () => this.emit('update')
    this._onDiscoveryError = (error) => this.emit('error', error)
    this._onDiscoveryDown = (service) => this.emit('peer-down', service)

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
    await this.dht.fullyBootstrapped()
    if (this.destroyed) return

    await this.swarm.listen()
    if (this.destroyed) return

    const address = this.dht.address()
    if (address && address.port) this.port = address.port

    const record = this._createRecord()
    await this._startDiscovery(record)
    if (this.destroyed) return

    this._advertisedSignature = recordSignature(record)
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

  _retainTopic (topic) {
    const id = topic.toString('hex')
    const existing = this._joinedTopics.get(id)

    if (existing) existing.refs++
    else {
      if (this._joinedTopics.size >= MAX_ADVERTISED_TOPICS) {
        throw new RangeError(`Cannot join more than ${MAX_ADVERTISED_TOPICS} LAN topics`)
      }
      this._joinedTopics.set(id, { topic: Buffer.from(topic), refs: 1 })
    }

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

  _createRecord () {
    return createRecord({
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

    const record = this._createRecord()
    const signature = recordSignature(record)
    if (signature === this._advertisedSignature) return
    const previous = this._advertisement
    this._advertisement = null
    await stopHandle(previous)
    if (!this._advertising || this.suspended || this.destroyed) return

    this._advertisement = await this.adapter.advertise(record, {
      onError: this._onDiscoveryError
    })
    assertHandle(this._advertisement, 'advertise')
    this._advertisedSignature = signature
  }

  async _handleService (service) {
    if (this.destroyed || this.suspended) return

    const record = parseRecord(service)
    const host = serviceIPv4(service)
    if (!record || !host) return
    if (record.peerKey.equals(this.keyPair.publicKey)) return

    const id = record.peerKey.toString('hex')
    const previous = this._knownPeers.get(id)
    const peer = {
      host,
      port: record.port,
      publicKey: record.peerKey,
      tokens: record.tokens,
      reachable: previous?.reachable === true &&
        previous.host === host && previous.port === record.port,
      lastSignature: previous?.lastSignature || null,
      lastSeen: previous?.lastSeen || 0
    }

    this._knownPeers.set(id, peer)
    await this._considerPeer(peer)
  }

  async _considerPeer (peer) {
    if (this.destroyed || this.suspended) return

    const id = peer.publicKey.toString('hex')
    const matchedTopics = this._matchingTopics(peer.tokens)
    const signature = `${peer.host}:${peer.port}|${peer.tokens.join(',')}|${this._localTokenSignature()}`
    const now = Date.now()

    this._peerTopics.set(id, matchedTopics)
    this._updateConnectionTopics(id, matchedTopics)

    if (matchedTopics.length === 0) this._disconnectDirect(id)

    if (signature === peer.lastSignature && now - peer.lastSeen < PEER_REFRESH_INTERVAL) return
    peer.lastSignature = signature
    peer.lastSeen = now

    const visiblePeer = { ...peer, topics: matchedTopics }
    delete visiblePeer.lastSignature
    delete visiblePeer.lastSeen
    this.emit('peer', visiblePeer)

    if (!peer.reachable) {
      this.dht.addNode(peer)

      try {
        await this.dht.ping(peer, { retry: false })
      } catch (error) {
        error.message = `Could not reach discovered LAN DHT node ${peer.host}:${peer.port}: ${error.message}`
        this.emit('warning', error)
        return
      }

      peer.reachable = true
      this.dht.refresh()

      const discoveries = [...this.swarm.topics()]
      await refreshAll(discoveries)
      await refreshAll(discoveries)
    }

    if (this._direct && matchedTopics.length > 0) this._connectDirect(peer, matchedTopics)
    this.emit('peer-reachable', visiblePeer)
  }

  _matchingTopics (tokens) {
    const local = new Map()
    for (const entry of this._joinedTopics.values()) {
      local.set(topicToken(entry.topic), entry.topic)
    }

    const matched = []
    for (const token of tokens) {
      if (local.has(token)) matched.push(Buffer.from(local.get(token)))
    }
    return matched
  }

  _localTokenSignature () {
    return [...this._joinedTopics.values()]
      .map(entry => topicToken(entry.topic))
      .sort()
      .join(',')
  }

  _handleSwarmConnection (socket, peerInfo) {
    const publicKey = socket.remotePublicKey || peerInfo.publicKey
    if (!publicKey) return socket.destroy()

    const id = publicKey.toString('hex')
    const discoveredTopics = Array.isArray(peerInfo.topics) ? peerInfo.topics : []
    const topics = discoveredTopics.length > 0
      ? discoveredTopics.filter(topic => this._joinedTopics.has(topic.toString('hex')))
      : (this._peerTopics.get(id) || [])

    if (topics.length === 0) return socket.destroy()

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
      relayAddresses,
      localConnection: true
    })
    this._directConnections.set(id, socket)

    socket.once('open', () => {
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
    socket.once('close', () => {
      if (this._directConnections.get(id) === socket) this._directConnections.delete(id)
      if (this._connectionInfo.get(id)?.socket === socket) this._connectionInfo.delete(id)
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
    const socket = this._directConnections.get(id)
    if (socket) socket.destroy()
  }

  async suspend (opts) {
    if (this.suspended || this.destroyed) return
    await this.ready()
    this.suspended = true
    this._advertising = false

    await this._advertisementQueue
    await this._stopDiscovery()
    for (const socket of this._directConnections.values()) socket.destroy()
    this._directConnections.clear()
    await this.swarm.suspend(opts)
  }

  async resume (opts) {
    if (!this.suspended || this.destroyed) return
    await this.swarm.resume(opts)
    const record = this._createRecord()
    await this._startDiscovery(record)
    this._advertisedSignature = recordSignature(record)
    this._advertising = true
    this.suspended = false
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
    this.swarm.removeListener('connection', this._onConnection)
    this.swarm.removeListener('update', this._onUpdate)
    await this._advertisementQueue
    await this._stopDiscovery()
    for (const socket of this._directConnections.values()) socket.destroy()
    this._directConnections.clear()
    if (this._destroySwarm) await this.swarm.destroy()

    this.emit('close')
  }

  async _startDiscovery (record) {
    const browser = await this.adapter.browse({
      type: SERVICE_TYPE,
      protocol: SERVICE_PROTOCOL
    }, {
      onService: this._onServiceDiscovered,
      onServiceDown: this._onDiscoveryDown,
      onError: this._onDiscoveryError
    })
    assertHandle(browser, 'browse')

    let advertisement
    try {
      advertisement = await this.adapter.advertise(record, {
        onError: this._onDiscoveryError
      })
      assertHandle(advertisement, 'advertise')
    } catch (error) {
      await stopHandle(browser)
      throw error
    }

    this._browser = browser
    this._advertisement = advertisement
  }

  async _stopDiscovery () {
    const browser = this._browser
    const advertisement = this._advertisement
    this._browser = null
    this._advertisement = null
    await Promise.all([stopHandle(browser), stopHandle(advertisement)])
  }
}

HyperswarmLAN.DEFAULT_PORT = DEFAULT_PORT
HyperswarmLAN.MAX_ADVERTISED_TOPICS = MAX_ADVERTISED_TOPICS

module.exports = HyperswarmLAN

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

function recordSignature (record) {
  return JSON.stringify(record.txt)
}

function refreshAll (discoveries) {
  return Promise.allSettled(discoveries.map((discovery) => discovery.refresh()))
}
