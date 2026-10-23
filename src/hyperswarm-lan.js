'use strict'

const { EventEmitter } = require('events')
const HyperDHT = require('hyperdht')
const Hyperswarm = require('hyperswarm')
const { selectLocalIPv4, serviceIPv4 } = require('./network')
const { createLANDHT, defaultHostKey } = require('./lan-dht')
const { Counter, RateLimiter } = require('./limits')
const {
  NAME_PATTERN,
  SERVICE_PROTOCOL,
  SERVICE_TYPE,
  createRecord,
  parseRecord,
  randomName
} = require('./record')

const DEFAULT_PORT = 49799

const DEFAULT_LIMITS = {
  // Connections, both directions, like the internet swarm. No full mesh: big
  // rooms pass messages on, so not everyone needs everyone.
  maxPeers: 64,
  // This device dials no one once it has this many, so there is always room
  // for a device that has just arrived to connect to it.
  outgoingPeers: 40,
  // Dialled per topic, fewer when a device is in many, so one big room cannot
  // take every connection from the small ones.
  peersPerTopic: 8,
  connectionsPerIP: 4,
  // The mDNS discovery list.
  maxDevices: 256,
  devicesPerIP: 4,
  deviceTTL: 6 * 60_000,
  // Sightings processed per sender: a burst, then one every two seconds.
  sightingsPerSecond: 0.5,
  sightingBurst: 16,
  // mDNS only finds the first few neighbours; the DHT finds the rest.
  maxSeeds: 32,
  pingsPerSecond: 10,
  pingInterval: 30_000,
  // The LAN DHT.
  nodesPerIP: 4,
  requestsPerSecond: 50,
  requestBurst: 200,
  requestsPerSecondTotal: 2000,
  announcesPerSecond: 0.5,
  announceBurst: 128,
  topicAnnounceInterval: 300,
  announcesPerTopic: 4,
  records: 8192,
  // Topic changes and refreshes.
  batchInterval: 2000,
  joinsPerBatch: 8,
  refreshCooldown: 15_000,
  refreshesPerSecond: 4,
  // Lookups shortly after a join, for a device that joined at the same
  // moment. Lookups only: nothing is announced again.
  followUps: [1000, 5000],
  sweepInterval: 15_000,
  // A connection that hears nothing, not even the keepalives sent every
  // five seconds, is closed: the other device went into airplane mode or
  // left the Wi-Fi, and its slot is freed for someone who is there.
  connectionTimeout: 15_000
}

const OWN_RECORD_REFRESH = 5 * 60_000
const REQUERY_INTERVAL = 30_000
// A table this small is still being built, so each new node is worth a look
// for the topics already joined.
const SMALL_TABLE = 8

/**
 * Local network discovery for Hyperswarm: an isolated HyperDHT on the LAN,
 * seeded by mDNS.
 *
 * What the network learns: mDNS says only that a device is at an address and
 * port, under a name made up for this run. Topics are found through the LAN
 * DHT, which needs the topic to ask for it. Connections use a key pair made up
 * for this run as well, so the device's long-term key never goes on the
 * network; who a device is can be proven inside the encrypted channel, to the
 * peers that need to know (see ./identity).
 *
 * Scale: mDNS finds a few dozen neighbours to start from and the DHT does the
 * rest, as on the internet. Connections are capped at maxPeers in both
 * directions, topic changes are applied in batches, and refreshes are
 * rate limited and happen on jittered timers rather than whenever someone
 * shows up.
 *
 * One hostile device: every table is bounded, with a few entries per IP
 * address at most, and mDNS sightings, DHT requests, announcements, pings and
 * refreshes are rate limited.
 */
class HyperDHTmDNS extends EventEmitter {
  constructor (opts = {}) {
    super()

    this.destroyed = false
    this.suspended = false
    this.limits = { ...DEFAULT_LIMITS, ...opts.limits }
    this._allowLoopback = opts.allowLoopback === true
    this._autoHost = !opts.host
    this.host = opts.host || selectLocalIPv4(undefined, this._allowLoopback)
    this.port = opts.port === undefined ? DEFAULT_PORT : opts.port
    this.name = randomName()
    this._hostKey = typeof opts.hostKey === 'function' ? opts.hostKey : defaultHostKey
    this._ownsSwarm = !opts.swarm
    this._destroySwarm = this._ownsSwarm && opts.destroySwarm !== false

    if (opts.swarm) {
      this.swarm = opts.swarm
      this.dht = opts.dht || opts.swarm.dht
      this.keyPair = opts.keyPair || opts.swarm.keyPair
      this.ephemeral = !opts.keyPair && !opts.swarm.keyPair
    } else {
      // Made up for this run: the key that goes on the network says nothing
      // about who the device is, and is different on the next network.
      this.ephemeral = !opts.keyPair && !opts.seed
      this.keyPair = opts.keyPair || HyperDHT.keyPair(opts.seed)
      this.dht = opts.dht || createLANDHT({
        port: this.port,
        host: this.host,
        keyPair: this.keyPair,
        limits: this.limits,
        dhtOptions: opts.dhtOptions,
        hostKey: this._hostKey,
        allowLoopback: this._allowLoopback
      })
      this.swarm = new Hyperswarm({
        // hyperswarm only checks this before dialling; incoming connections
        // are capped at maxPeers in the handshake (_capServerConnections).
        maxPeers: this.limits.outgoingPeers,
        ...opts.swarmOptions,
        keyPair: this.keyPair,
        dht: this.dht
      })
      this._capServerConnections()
    }

    if (!this.dht) throw new TypeError('A supplied swarm must expose its dht instance')
    if (!this.keyPair || !Buffer.isBuffer(this.keyPair.publicKey)) {
      throw new TypeError('The swarm keyPair must expose a publicKey Buffer')
    }

    // Required here rather than at module load so that supplying `adapter`
    // avoids pulling in multicast-dns, and with it Node's dgram/os. That is
    // what lets the module run on runtimes without those builtins, such as
    // Bare, where the whole point of the adapter seam is to replace mDNS.
    this.adapter = opts.adapter || new (require('./mdns-adapter'))(opts.mdnsOptions)
    assertAdapter(this.adapter)

    this._devices = new Map()
    this._devicesPerHost = new Counter()
    this._connectionsPerHost = new Counter()
    this._sightings = new RateLimiter({ rate: this.limits.sightingsPerSecond, burst: this.limits.sightingBurst })
    this._pings = new RateLimiter({ rate: this.limits.pingsPerSecond, burst: this.limits.pingsPerSecond })
    this._refreshes = new RateLimiter({ rate: this.limits.refreshesPerSecond, burst: this.limits.refreshesPerSecond * 4 })
    this._topics = new Map()
    this._pendingSessions = new Set()
    this._batchTimer = null
    this._lastBatch = 0
    this._growthTimer = null
    this._lastGrowthRefresh = 0
    this._lastRequery = 0
    this._lastOwnRecordRefresh = Date.now()
    this._sweepTimer = null
    this._browser = null
    this._advertisement = null
    this._advertising = false
    this.stats = {
      sightingsDropped: 0,
      devicesRefused: 0,
      connectionsRefused: 0,
      pingsSent: 0,
      refreshes: 0,
      lookups: 0
    }

    this._onServiceDiscovered = (service) => this._handleService(service)
    this._onServiceDown = (service) => {
      if (this._handleServiceDown(service)) this.emit('peer-down', service)
    }
    this._onDiscoveryError = (error) => this.emit('warning', error)
    this._onConnection = (socket, peerInfo) => this._handleSwarmConnection(socket, peerInfo)
    this._onUpdate = () => this.emit('update')
    this._onAddNode = () => this._networkGrew()

    this.swarm.on('connection', this._onConnection)
    this.swarm.on('update', this._onUpdate)
    this.dht.on('add-node', this._onAddNode)
    this._opening = this._open()
    this._opening.catch(() => {})
  }

  get connections () {
    return this.swarm.connections
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

    await this._startDiscovery()
    if (this.destroyed) return

    this._startSweeping()
    this._flushTopics()
    this.emit('ready')
  }

  ready () {
    return this._opening
  }

  listen () {
    return this.ready()
  }

  /**
   * Join a topic on the local network. Changes are applied in batches, at
   * most joinsPerBatch new topics every batchInterval, so a burst of joins
   * does not become a burst of announcements; a lone join goes straight out.
   */
  join (topic, opts = {}) {
    assertTopic(topic)
    if (this.destroyed) throw new Error('Swarm destroyed')
    const id = topic.toString('hex')
    let entry = this._topics.get(id)
    if (!entry) {
      entry = { topic: Buffer.from(topic), sessions: new Set(), announced: false }
      this._topics.set(id, entry)
    }

    const session = new LANSession(this, entry, {
      server: opts.server !== false,
      client: opts.client !== false,
      limit: opts.limit
    })
    entry.sessions.add(session)
    this._pendingSessions.add(session)
    this._scheduleTopicFlush()
    return session
  }

  async leave (topic) {
    assertTopic(topic)
    const entry = this._topics.get(topic.toString('hex'))
    if (entry) {
      for (const session of [...entry.sessions]) await session.destroy()
    }
    return this.swarm.leave(topic)
  }

  joinPeer (publicKey) {
    return this.swarm.joinPeer(publicKey)
  }

  leavePeer (publicKey) {
    return this.swarm.leavePeer(publicKey)
  }

  async flush () {
    await this.ready()
    await this._applyAllPending()
    return this.swarm.flush()
  }

  topics () {
    return this.swarm.topics()
  }

  status (topic) {
    return this.swarm.status(topic)
  }

  /**
   * Where on the LAN a server with this public key can be reached: the
   * address of a DHT node that answered for it, which is the server's own
   * node or one that relays to it. Null when nobody answers in time.
   */
  async findPeer (publicKey, { timeout = 3000 } = {}) {
    const deadline = Date.now() + timeout
    // Asked again until the time is up: just after start this device may not
    // know any other yet, and the server may only now be saying where it is.
    while (!this.destroyed && !this.suspended && Date.now() < deadline) {
      if ((this.dht.nodes?.length || 0) > 0) {
        const found = await this._findPeerOnce(publicKey, deadline - Date.now())
        if (found) return found
      }
      await nextNode(this.dht, Math.min(250, Math.max(0, deadline - Date.now())))
    }
    return null
  }

  async _findPeerOnce (publicKey, timeout) {
    const query = this.dht.findPeer(publicKey)
    const timer = setTimeout(() => query.destroy(), Math.max(1, timeout))
    timer.unref?.()
    try {
      for await (const data of query) {
        if (data?.from?.host && data?.from?.port) return { host: data.from.host, port: data.from.port }
      }
    } catch {
      // Destroyed by the timeout, or no nodes to ask.
    } finally {
      clearTimeout(timer)
      query.destroy()
    }
    return null
  }

  /** How many devices, seeds, DHT nodes and connections this instance has. */
  info () {
    let seeds = 0
    for (const device of this._devices.values()) if (device.reachable) seeds++
    return {
      name: this.name,
      host: this.host,
      port: this.port,
      ephemeral: this.ephemeral,
      devices: this._devices.size,
      seeds,
      nodes: this.dht.nodes?.length || 0,
      connections: this.swarm.connections.size,
      topics: this._topics.size,
      stats: { ...this.stats, ...this.dht.hyperdhtMdns?.stats }
    }
  }

  _scheduleTopicFlush () {
    if (this._batchTimer || this.destroyed) return
    const wait = Math.max(0, this._lastBatch + this.limits.batchInterval - Date.now())
    this._batchTimer = setTimeout(() => {
      this._batchTimer = null
      this._flushTopics()
    }, wait)
    this._batchTimer.unref?.()
  }

  _flushTopics () {
    if (this.destroyed || this.suspended || !this._readyForTopics()) return

    let newTopics = 0
    let applied = 0
    for (const session of [...this._pendingSessions]) {
      if (session.destroyed) {
        this._pendingSessions.delete(session)
        continue
      }
      const isNew = !this.swarm.status(session.entry.topic)
      if (isNew && newTopics >= this.limits.joinsPerBatch) continue
      if (isNew) newTopics++
      this._pendingSessions.delete(session)
      this._applySession(session)
      applied++
    }
    // Only a batch that went out starts the wait for the next one, so a
    // lone join goes straight out.
    if (applied > 0) this._lastBatch = Date.now()
    if (this._pendingSessions.size > 0) this._scheduleTopicFlush()
  }

  async _applyAllPending () {
    for (const session of [...this._pendingSessions]) {
      this._pendingSessions.delete(session)
      if (!session.destroyed) this._applySession(session)
    }
  }

  _readyForTopics () {
    return this._advertising
  }

  // Peers dialled per topic: an even share of outgoingPeers over the topics
  // this device looks for, between 2 and peersPerTopic.
  _topicLimit () {
    let clientTopics = 0
    for (const entry of this._topics.values()) {
      if ([...entry.sessions].some((session) => session.applied && session.opts.client)) clientTopics++
    }
    const share = Math.floor(this.limits.outgoingPeers / Math.max(1, clientTopics))
    return Math.max(2, Math.min(this.limits.peersPerTopic, share))
  }

  // hyperswarm sets a topic's limit from whichever session refreshed last, and
  // a refresh without one lifts it, so it is put back here.
  _applyTopicLimits () {
    const limit = this._topicLimit()
    for (const entry of this._topics.values()) {
      if ([...entry.sessions].some((session) => session.opts.limit !== undefined)) continue
      const discovery = this.swarm.status(entry.topic)
      if (discovery) discovery.limit = limit
    }
    return limit
  }

  _applySession (session) {
    const { entry } = session
    session._apply(this.swarm.join(entry.topic, { ...session.opts, limit: session.opts.limit ?? this._topicLimit() }))
    this._applyTopicLimits()
    this._updateOwnRecord(entry)
    if (!session.opts.client) return
    // A device that joined at the same moment as this one is not yet in
    // the DHT when this lookup runs. A look or two shortly after finds it.
    for (const delay of this.limits.followUps || []) {
      const timer = setTimeout(() => {
        session._followUps.delete(timer)
        if (!session.destroyed) this._lookup(entry.topic)
      }, jitter(delay, 0.3))
      timer.unref?.()
      session._followUps.add(timer)
    }
  }

  // Peers under a topic, handed to the swarm to connect to as if its own
  // refresh had found them, without announcing again.
  async _lookup (topic) {
    if (this.destroyed || this.suspended || !this._refreshes.take('all')) return
    this.stats.lookups++
    const handle = typeof this.swarm._handlePeer === 'function'
      ? (peer) => this.swarm._handlePeer(peer, topic)
      : null
    if (!handle) {
      this.swarm.status(topic)?.refresh().catch(() => {})
      return
    }
    // As many as the topic's share allows, counting peers already connected
    // under it.
    const connected = new Set([...this.swarm.connections].map((socket) => socket.remotePublicKey?.toString('hex')))
    let budget = this._topicLimit()
    for (const peer of this.swarm.peers.values()) {
      if (connected.has(peer.publicKey.toString('hex')) && peer.topics.some((value) => value.equals(topic))) budget--
    }
    try {
      for await (const data of this.dht.lookup(topic)) {
        if (this.destroyed || this.suspended) return
        for (const peer of data.peers) {
          if (budget <= 0) return
          const id = peer.publicKey.toString('hex')
          if (peer.publicKey.equals(this.keyPair.publicKey) || connected.has(id)) continue
          connected.add(id)
          budget--
          handle(peer)
        }
      }
    } catch {
      // No nodes to ask, or destroyed meanwhile.
    }
  }

  _releaseSession (session) {
    const { entry } = session
    entry.sessions.delete(session)
    this._pendingSessions.delete(session)
    for (const timer of session._followUps) clearTimeout(timer)
    session._followUps.clear()
    this._updateOwnRecord(entry)
    if (entry.sessions.size === 0 && this._topics.get(entry.topic.toString('hex')) === entry) {
      this._topics.delete(entry.topic.toString('hex'))
    }
    this._applyTopicLimits()
  }

  // This device answers lookups for the topics it announces (see lan-dht).
  _updateOwnRecord (entry) {
    const announcing = [...entry.sessions].some((session) => session.applied && session.opts.server)
    const store = this.dht.hyperdhtMdns
    if (!store || announcing === entry.announced) return
    entry.announced = announcing
    if (announcing) store.storeOwnRecord(entry.topic, this.keyPair.publicKey, [{ host: this.host, port: this.port }])
    else store.removeOwnRecord(entry.topic, this.keyPair.publicKey)
  }

  // The routing table grew. While it is still small, each new node can be the
  // one that knows the topics already joined, so they are looked up again,
  // at most once per refreshCooldown. A big table only changes on the timers.
  _networkGrew () {
    if (this.destroyed || this.suspended) return
    const nodes = this.dht.nodes?.length || 0
    if (nodes > SMALL_TABLE) return
    const wait = this._lastGrowthRefresh + this.limits.refreshCooldown - Date.now()
    if (wait > 0) {
      if (!this._growthTimer) {
        this._growthTimer = setTimeout(() => {
          this._growthTimer = null
          this._refreshAll()
        }, wait)
        this._growthTimer.unref?.()
      }
      return
    }
    this._refreshAll()
  }

  _refreshAll () {
    if (this.destroyed || this.suspended) return
    this._lastGrowthRefresh = Date.now()
    for (const discovery of this.swarm.topics()) {
      if (!this._refreshes.take('all')) break
      this.stats.refreshes++
      discovery.refresh().catch(() => {})
    }
    // Servers listening on this DHT directly, such as a note's host, say
    // where they are again too.
    for (const server of this.dht.listening || []) server.refresh?.()
  }

  _handleService (service) {
    if (this.destroyed || this.suspended) return
    const host = serviceIPv4(service)
    if (!host) return
    const sender = service.referer?.address || host
    if (!this._sightings.take(this._hostKey({ host: sender, port: service.referer?.port }))) {
      this.stats.sightingsDropped++
      return
    }

    const record = parseRecord(service)
    if (!record || record.name === this.name) return

    const now = Date.now()
    const id = `${record.name}@${host}`
    const existing = this._devices.get(id)
    if (existing) {
      existing.lastSeen = now
      if (existing.port !== record.port) {
        existing.port = record.port
        existing.reachable = false
        existing.failures = 0
      }
      this._seed()
      return
    }

    const hostKey = this._hostKey({ host, port: record.port })
    if (this._devicesPerHost.get(hostKey) >= this.limits.devicesPerIP) {
      this.stats.devicesRefused++
      return
    }
    if (this._devices.size >= this.limits.maxDevices && !this._evictStalest(now)) {
      this.stats.devicesRefused++
      return
    }

    const device = {
      id,
      name: record.name,
      host,
      port: record.port,
      hostKey,
      firstSeen: now,
      lastSeen: now,
      pingedAt: 0,
      failures: 0,
      reachable: false,
      pinging: false
    }
    this._devices.set(id, device)
    this._devicesPerHost.add(hostKey)
    this.adapter.setPopulation?.(this._devices.size)
    this.emit('peer', visibleDevice(device))
    this._seed()
  }

  _handleServiceDown (service) {
    const name = String(service?.name || '').toLowerCase()
    if (!NAME_PATTERN.test(name)) return false
    // A goodbye counts only from the device's own address, so nobody can
    // say goodbye for someone else.
    const sender = service.referer?.address
    for (const device of this._devices.values()) {
      if (device.name !== name) continue
      if (sender && sender !== device.host) continue
      this._removeDevice(device)
      return true
    }
    return false
  }

  _removeDevice (device) {
    if (this._devices.get(device.id) !== device) return
    this._devices.delete(device.id)
    this._devicesPerHost.remove(device.hostKey)
    this.adapter.setPopulation?.(this._devices.size)
  }

  // A full list makes room only by dropping a device that has gone quiet.
  _evictStalest (now) {
    let stalest = null
    for (const device of this._devices.values()) {
      if (!stalest || device.lastSeen < stalest.lastSeen) stalest = device
    }
    if (!stalest || now - stalest.lastSeen < this.limits.deviceTTL / 2) return false
    this._removeDevice(stalest)
    this.emit('peer-down', visibleDevice(stalest))
    return true
  }

  // Hands a few devices from the discovery list to the DHT, by pinging them:
  // a node that answers is added to the routing table the normal way, under
  // the per-address limit. Stops once maxSeeds answered.
  _seed () {
    if (this.destroyed || this.suspended || !this._advertising) return
    let seeds = 0
    const candidates = []
    const now = Date.now()
    for (const device of this._devices.values()) {
      // A ping still on its way counts, or overlapping rounds overshoot.
      if (device.reachable || device.pinging) seeds++
      else if (now - device.pingedAt >= this.limits.pingInterval * Math.min(8, 2 ** device.failures)) candidates.push(device)
    }
    if (seeds >= this.limits.maxSeeds) return

    for (const device of spreadByHost(shuffle(candidates))) {
      if (seeds++ >= this.limits.maxSeeds) break
      if (!this._pings.take('all')) break
      this._ping(device)
    }
  }

  async _ping (device) {
    device.pingedAt = Date.now()
    device.pinging = true
    this.stats.pingsSent++
    try {
      await this.dht.ping({ host: device.host, port: device.port })
    } catch (error) {
      device.pinging = false
      device.failures++
      device.reachable = false
      if (!this.destroyed && !this.suspended) {
        error.message = `Could not reach discovered LAN DHT node ${device.host}:${device.port}: ${error.message}`
        this.emit('warning', error)
      }
      return
    }
    device.pinging = false
    if (this.destroyed || this._devices.get(device.id) !== device) return
    device.failures = 0
    device.lastSeen = Date.now()
    if (!device.reachable) {
      device.reachable = true
      this.emit('peer-reachable', visibleDevice(device))
    }
  }

  _startSweeping () {
    const sweep = () => {
      this._sweepTimer = setTimeout(sweep, jitter(this.limits.sweepInterval, 0.2))
      this._sweepTimer.unref?.()
      this._sweep()
    }
    this._sweepTimer = setTimeout(sweep, jitter(this.limits.sweepInterval, 0.2))
    this._sweepTimer.unref?.()
  }

  _sweep () {
    if (this.destroyed || this.suspended) return
    const now = Date.now()

    // Gone without a goodbye: a device not heard from for deviceTTL drops
    // out. A seed is pinged first and kept while it answers, announcing or
    // not; the rest are found again over mDNS if they are still there.
    for (const device of [...this._devices.values()]) {
      if (now - device.lastSeen < this.limits.deviceTTL || device.pinging) continue
      if (!device.reachable || device.failures >= 2) {
        this._removeDevice(device)
        this.emit('peer-down', visibleDevice(device))
      } else if (now - device.pingedAt >= this.limits.pingInterval && this._pings.take('all')) {
        this._ping(device)
      }
    }

    // Every neighbour lost, as after the Wi-Fi was off: ask again.
    if ((this.dht.nodes?.length || 0) === 0 && now - this._lastRequery >= REQUERY_INTERVAL) {
      this._lastRequery = now
      this._browser?.query?.()
    }

    if (now - this._lastOwnRecordRefresh >= OWN_RECORD_REFRESH) {
      this._lastOwnRecordRefresh = now
      this.dht.hyperdhtMdns?.refreshOwnRecords()
    }

    this._seed()
  }

  _handleSwarmConnection (socket, peerInfo) {
    const publicKey = socket.remotePublicKey || peerInfo?.publicKey
    if (this.destroyed || !publicKey) {
      socket.on('error', noop)
      if (this._ownsSwarm) socket.destroy()
      return
    }
    // Handshakes in flight are not counted when the firewall lets them in,
    // so a burst can open past the cap. The newest goes.
    if (this._ownsSwarm && this.swarm.connections.size > this.limits.maxPeers) {
      this.stats.connectionsRefused++
      socket.on('error', noop)
      socket.destroy()
      return
    }

    const host = socket.rawStream?.remoteHost || null
    const hostKey = host ? this._hostKey({ host }) : null
    if (this._ownsSwarm && hostKey && this._connectionsPerHost.get(hostKey) >= this.limits.connectionsPerIP) {
      this.stats.connectionsRefused++
      socket.on('error', noop)
      socket.destroy()
      return
    }
    if (hostKey) {
      this._connectionsPerHost.add(hostKey)
      socket.once('close', () => this._connectionsPerHost.remove(hostKey))
    }

    // Errors end the connection; nobody else may be listening for them.
    socket.on('error', noop)
    socket.setTimeout?.(this.limits.connectionTimeout)

    const info = {
      publicKey,
      relayAddresses: peerInfo?.relayAddresses || [],
      topics: Array.isArray(peerInfo?.topics) ? [...peerInfo.topics] : [],
      client: peerInfo?.client === true,
      lan: true,
      // The other side's key is made up for this network, not who they are.
      ephemeral: true
    }
    this.emit('connection', socket, info)
    this.emit('update')
  }

  // Incoming connections are capped as outgoing ones are, and at
  // connectionsPerIP from one address. Refused in the handshake, without
  // hyperswarm's ban, so the same peer can come back once there is room.
  _capServerConnections () {
    const server = this.swarm.server
    if (!server) return
    const firewall = server.firewall
    server.firewall = (remotePublicKey, payload, address) => {
      if (this.swarm.connections.size >= this.limits.maxPeers) {
        this.stats.connectionsRefused++
        return true
      }
      const hostKey = address?.host ? this._hostKey(address) : null
      if (hostKey && this._connectionsPerHost.get(hostKey) >= this.limits.connectionsPerIP) {
        this.stats.connectionsRefused++
        return true
      }
      return firewall(remotePublicKey, payload, address)
    }
  }

  async suspend (opts) {
    if (this.suspended || this.destroyed) return
    await this.ready()
    this.suspended = true
    this._advertising = false
    this._stopTimers()
    await this._stopDiscovery()
    for (const device of this._devices.values()) device.reachable = false
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
    try {
      await this._startDiscovery()
    } catch (error) {
      this.suspended = true
      await this.swarm.suspend(opts).catch(() => {})
      throw error
    }
    this._startSweeping()
    this._flushTopics()
    for (const device of this._devices.values()) {
      device.pingedAt = 0
      device.failures = 0
    }
    this._seed()
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
    this._stopTimers()
    this.dht.removeListener('add-node', this._onAddNode)
    const sessions = [...this._topics.values()].flatMap((entry) => [...entry.sessions])
    await Promise.allSettled(sessions.map((session) => session.destroy()))
    this._pendingSessions.clear()
    await this._stopDiscovery()
    if (this._destroySwarm) await this.swarm.destroy()
    // Removed only now: a connection opening during teardown still gets an
    // error handler and is closed.
    this.swarm.removeListener('connection', this._onConnection)
    this.swarm.removeListener('update', this._onUpdate)

    this.emit('close')
  }

  _stopTimers () {
    clearTimeout(this._sweepTimer)
    clearTimeout(this._batchTimer)
    clearTimeout(this._growthTimer)
    this._sweepTimer = null
    this._batchTimer = null
    this._growthTimer = null
  }

  async _startDiscovery () {
    const browser = await this.adapter.browse({
      type: SERVICE_TYPE,
      protocol: SERVICE_PROTOCOL
    }, {
      onService: this._onServiceDiscovered,
      onServiceDown: this._onServiceDown,
      onError: this._onDiscoveryError
    })
    assertHandle(browser, 'browse')

    let advertisement
    try {
      advertisement = await this.adapter.advertise({
        ...createRecord({ port: this.port, name: this.name }),
        // For adapters that publish the address record themselves: the one
        // address the DHT is bound to, nothing else.
        address: this.host
      }, {
        onError: this._onDiscoveryError
      })
      assertHandle(advertisement, 'advertise')
    } catch (error) {
      await stopHandle(browser)
      throw error
    }

    this._browser = browser
    this._advertisement = advertisement
    this._advertising = true
  }

  async _stopDiscovery () {
    const browser = this._browser
    const advertisement = this._advertisement
    this._browser = null
    this._advertisement = null
    await Promise.all([stopHandle(browser), stopHandle(advertisement)])
  }
}

/**
 * One join on the local network. Usable at once; it goes out with the next
 * batch of topic changes.
 */
class LANSession {
  constructor (lan, entry, opts) {
    this.lan = lan
    this.entry = entry
    this.topic = entry.topic
    this.opts = opts
    this.applied = null
    this.destroyed = false
    this._followUps = new Set()
    this._waiters = []
  }

  _apply (session) {
    this.applied = session
    for (const resolve of this._waiters) resolve()
    this._waiters = []
  }

  _whenApplied () {
    if (this.applied || this.destroyed) return Promise.resolve()
    return new Promise((resolve) => this._waiters.push(resolve))
  }

  async refresh (opts = {}) {
    await this._whenApplied()
    if (!this.applied || this.destroyed) return false
    // Without a limit hyperswarm would dial every peer it finds under the topic.
    const limit = opts.limit ?? this.opts.limit ?? this.lan._topicLimit()
    return this.applied.refresh({ ...opts, limit })
  }

  async flushed () {
    await this._whenApplied()
    if (!this.applied || this.destroyed) return false
    return this.applied.flushed()
  }

  async destroy () {
    if (this.destroyed) return
    this.destroyed = true
    for (const resolve of this._waiters) resolve()
    this._waiters = []
    this.lan._releaseSession(this)
    if (this.applied) await this.applied.destroy()
  }
}

HyperDHTmDNS.DEFAULT_PORT = DEFAULT_PORT
HyperDHTmDNS.DEFAULT_LIMITS = DEFAULT_LIMITS

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
  return handle ? Promise.resolve(handle.stop()) : Promise.resolve()
}

function visibleDevice (device) {
  return { name: device.name, host: device.host, port: device.port, topics: [] }
}

// A new node in the routing table, or ms, whichever comes first.
function nextNode (dht, ms) {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer)
      dht.removeListener('add-node', done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    timer.unref?.()
    dht.once('add-node', done)
  })
}

function jitter (ms, share) {
  return Math.round(ms * (1 + (Math.random() * 2 - 1) * share))
}

// One device per address first, then the rest, so a machine with several
// names does not take every slot.
function spreadByHost (devices) {
  const seen = new Set()
  const first = []
  const rest = []
  for (const device of devices) {
    if (seen.has(device.hostKey)) rest.push(device)
    else {
      seen.add(device.hostKey)
      first.push(device)
    }
  }
  return first.concat(rest)
}

function shuffle (list) {
  for (let i = list.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    const swap = list[i]
    list[i] = list[j]
    list[j] = swap
  }
  return list
}

function noop () {}
