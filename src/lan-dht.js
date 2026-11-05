'use strict'

const HyperDHT = require('hyperdht')
const c = require('compact-encoding')
const m = require('hyperdht/lib/messages')
const NoiseWrap = require('hyperdht/lib/noise-wrap')
const { Counter, RateLimiter } = require('./limits')

// From dht-rpc, which is not a direct dependency: the first byte of a request
// packet (lib/io.js) and the delayed ping command (lib/commands.js).
const REQUEST_ID = 0x03
const DELAYED_PING = 4
const GUARDED = Symbol('hyperdht-mdns.guarded')

/**
 * The isolated DHT a device runs on the local network, made hard to take
 * over or knock down from one machine on the same Wi-Fi:
 *
 * - at most `nodesPerIP` routing table entries come from one IP address, so
 *   one machine running many DHT nodes cannot fill this device's view of the
 *   network (dht-rpc derives node ids from address and port, so a machine
 *   gets more ids only by opening more ports);
 * - request packets are rate limited per sender and overall as they arrive,
 *   before dht-rpc reads them;
 * - topic announcements are rate limited per sender and per sender and
 *   topic, so one machine cannot drown a topic in fake peers, and the record
 *   store is smaller than on the internet;
 * - this device answers lookups for the topics it announces itself. With two
 *   or three devices, each one's announcement is stored only on the others,
 *   and a lookup never asks the node it runs on, so two devices could not
 *   find each other through the DHT alone;
 * - nothing outside the local network gets in or out (localAddresses):
 *   requests, replies, relays, hole punches and connections. The node is
 *   reachable the way an internet DHT node is, and once a packet from its
 *   port has crossed the router, the router's UDP mapping lets internet
 *   nodes reach it; one that adds it shares it with others, and with no
 *   such check it joins the internet DHT and takes this network's
 *   announcements there.
 *
 * It listens on the one LAN address, not on every interface, and has a UDX
 * of its own (dhtOptions.udx is ignored), so the checks on its sockets touch
 * nothing else, such as an internet DHT's.
 */
function createLANDHT ({ port, host, keyPair, limits, dhtOptions = {}, hostKey = defaultHostKey, allowLoopback = false }) {
  const dht = HyperDHT.bootstrapper(port, host, {
    maxSize: limits.records,
    ...dhtOptions,
    host,
    udx: undefined,
    bootstrap: [],
    keyPair
  })
  return hardenDHT(dht, { limits, hostKey, isLocal: localAddresses(host, { allowLoopback }) })
}

function hardenDHT (dht, { limits, hostKey = defaultHostKey, isLocal = () => true }) {
  const nodesPerHost = new Counter()
  const state = {
    stats: { droppedRequests: 0, droppedAnnounces: 0, refusedNodes: 0, outsideDropped: 0 },
    ownRecords: new Map()
  }

  const outside = (host) => {
    if (isLocal(host)) return false
    state.stats.outsideDropped++
    return true
  }

  // Closer nodes outside are left out of every answer before a query sees
  // them, and a request to an address outside is not made, which an
  // explicit ping or request reports as an error. Packets from outside are
  // dropped on the sockets (below).
  const onresponse = dht.io.onresponse
  dht.io.onresponse = (res, external) => {
    if (Array.isArray(res.closerNodes) && res.closerNodes.some((node) => !isLocal(node.host))) {
      const before = res.closerNodes.length
      res.closerNodes = res.closerNodes.filter((node) => isLocal(node.host))
      state.stats.outsideDropped += before - res.closerNodes.length
    }
    onresponse(res, external)
  }
  // addNode skips dht-rpc's filter.
  const addNode = dht.addNode.bind(dht)
  dht.addNode = (node) => {
    if (outside(node?.host)) return
    addNode(node)
  }
  const createRequest = dht.io.createRequest.bind(dht.io)
  dht.io.createRequest = (to, ...rest) => {
    if (outside(to?.host)) return null
    return createRequest(to, ...rest)
  }

  // Counted from the table itself, so nodes dropped for not answering free
  // their place for someone else on that address.
  dht.on('add-node', (node) => nodesPerHost.add(hostKey(node)))
  dht.on('remove-node', (node) => nodesPerHost.remove(hostKey(node)))

  const filterNode = dht._filterNode
  dht._filterNode = (node) => {
    if (outside(node.host)) return false
    if (filterNode && !filterNode(node)) return false
    // A node already in the table is only being refreshed.
    if (node.id && dht.table.get(node.id)) return true
    if (nodesPerHost.get(hostKey(node)) >= limits.nodesPerIP) {
      state.stats.refusedNodes++
      return false
    }
    return true
  }

  // Every socket this DHT makes, now or later (hyperdht's hole punching
  // sockets too), checks each datagram before dht-rpc or hyperdht sees it.
  // One from outside is dropped, so it costs nothing, not even a place in
  // the rate limits. A request is counted when it arrives, before dht-rpc
  // answers one with a token it did not hand out by itself. And nothing is
  // sent outside: not a reply, a relay or a hole punch, whatever address a
  // message names.
  const perSender = new RateLimiter({ rate: limits.requestsPerSecond, burst: limits.requestBurst })
  const overall = new RateLimiter({ rate: limits.requestsPerSecondTotal, burst: limits.requestsPerSecondTotal })
  const admit = (buffer, rinfo) => {
    if (outside(rinfo?.host)) return false
    if (buffer?.[0] === REQUEST_ID && (!perSender.take(hostKey(rinfo)) || !overall.take('all'))) {
      state.stats.droppedRequests++
      return false
    }
    return true
  }
  const guardSocket = (socket) => {
    if (!socket || socket[GUARDED]) return socket
    socket[GUARDED] = true
    const { emit, send, trySend } = socket
    socket.emit = function (name, ...args) {
      if (name === 'message' && !admit(args[0], args[1])) return false
      return emit.call(this, name, ...args)
    }
    // udx sends to 127.0.0.1 when no host is given.
    socket.send = function (buffer, port, host, ttl) {
      if (outside(host || '127.0.0.1')) return Promise.resolve(false)
      return send.call(this, buffer, port, host, ttl)
    }
    socket.trySend = function (buffer, port, host, ttl) {
      if (outside(host || '127.0.0.1')) return
      return trySend.call(this, buffer, port, host, ttl)
    }
    return socket
  }
  const createSocket = dht.udx.createSocket
  dht.udx.createSocket = function (...args) {
    return guardSocket(createSocket.apply(this, args))
  }
  guardSocket(dht.io.serverSocket)
  guardSocket(dht.io.clientSocket)
  for (const socket of dht._socketPool?._sockets?.keys() || []) guardSocket(socket)

  // For requests handed in directly; the sockets check the rest.
  const onrequest = dht.io.onrequest
  dht.io.onrequest = (req, external) => {
    if (outside(req.from?.host)) return
    // Nothing in hyperdht or hyperswarm asks for one, and each would hold a
    // timer and a receive buffer for up to ten seconds.
    if (req.internal && req.command === DELAYED_PING) {
      state.stats.droppedRequests++
      return
    }
    onrequest(req, external)
  }

  // UDX streams send from native code, past the socket checks. A server
  // refuses a client outside before a stream exists (its firewall runs
  // first), and every stream refuses an address outside. Refused, not
  // thrown: hyperdht connects in the background, with nothing to catch it.
  const createServer = dht.createServer
  dht.createServer = function (opts, onconnection) {
    // hyperdht's createServer(fn) calls this.createServer({}, fn): one wrap.
    if (typeof opts === 'function') {
      onconnection = opts
      opts = {}
    }
    const server = createServer.call(this, opts, onconnection)
    const firewall = server.firewall
    server.firewall = function (remotePublicKey, payload, address) {
      if (outside(address?.host)) return true
      return firewall.call(this, remotePublicKey, payload, address)
    }
    return server
  }
  const refuse = (stream) => {
    const error = new Error('Not connecting outside the local network')
    stream.destroy(error)
    return error
  }
  const createStream = dht.udx.createStream
  dht.udx.createStream = function (id, opts = {}) {
    const firewall = opts.firewall
    const stream = createStream.call(this, id, {
      ...opts,
      // For a packet from an address the stream is not connected to: true
      // drops it, false lets hyperdht connect the stream there.
      firewall: (socket, port, host, family) => outside(host) || (firewall ? firewall(socket, port, host, family) : true)
    })
    const { connect, changeRemote } = stream
    stream.connect = function (socket, remoteId, port, host, connectOpts) {
      if (outside(typeof host === 'string' && host ? host : '127.0.0.1')) {
        refuse(this)
        return
      }
      return connect.call(this, socket, remoteId, port, host, connectOpts)
    }
    stream.changeRemote = function (socket, remoteId, port, host) {
      if (outside(host || '127.0.0.1')) return Promise.reject(refuse(this))
      return changeRemote.call(this, socket, remoteId, port, host)
    }
    return stream
  }

  // A client goes to a server only at local addresses too: the one a relay
  // gives for the server, and those the server lists for itself. Checked
  // here, an address outside ends that try before the handshake is done,
  // rather than once the stream is refused (above), and a server that lists
  // an address elsewhere as well is reached at its local one.
  const router = dht._router
  const peerHandshake = router.peerHandshake
  router.peerHandshake = async function (...args) {
    const reply = await peerHandshake.apply(this, args)
    if (outside(reply?.serverAddress?.host)) throw new Error('Not connecting outside the local network')
    return reply
  }
  const connectPeer = dht.connect
  dht.connect = function (remotePublicKey, opts) {
    opts = opts || {}
    const createHandshake = opts.createHandshake || ((keyPair, publicKey) => new NoiseWrap(keyPair, publicKey))
    return connectPeer.call(this, remotePublicKey, {
      ...opts,
      createHandshake: (keyPair, publicKey) => localAddressesOnly(createHandshake(keyPair, publicKey), outside)
    })
  }

  const announcesPerSender = new RateLimiter({
    rate: limits.announcesPerSecond,
    burst: limits.announceBurst
  })
  const announcesPerTopic = new RateLimiter({
    rate: 1 / limits.topicAnnounceInterval,
    burst: limits.announcesPerTopic,
    maxKeys: 16384
  })
  const guardPersistent = () => {
    const persistent = dht._persistent
    if (!persistent || persistent._hyperdhtMdnsGuarded) return
    persistent._hyperdhtMdnsGuarded = true

    const onannounce = persistent.onannounce.bind(persistent)
    persistent.onannounce = (req) => {
      // Refreshes and unannounces carry no new record.
      if (req.target && req.value) {
        const sender = hostKey(req.from)
        const topic = req.target.toString('hex')
        if (!announcesPerSender.take(sender) || !announcesPerTopic.take(`${sender}/${topic}`)) {
          state.stats.droppedAnnounces++
          // Answered but not stored, so an honest device announcing too often
          // is not left waiting on a timeout.
          req.reply(null, { token: false, closerNodes: false })
          return
        }
      }
      onannounce(req)
    }

    // hyperswarm's first announce of a topic clears old records, and that
    // drops this node's own record from its store too. Put back while this
    // device still announces the topic.
    const unannounce = persistent.unannounce.bind(persistent)
    persistent.unannounce = (target, publicKey) => {
      unannounce(target, publicKey)
      const own = state.ownRecords.get(Buffer.from(target).toString('hex'))
      if (own && Buffer.from(publicKey).equals(own.publicKey)) {
        persistent.records.add(Buffer.from(target).toString('hex'), own.publicKey, own.record)
      }
    }

    // Own announcements go into this node's store too, so a lookup that
    // reaches this node finds this device.
    for (const [topic, { publicKey, record }] of state.ownRecords) {
      persistent.records.add(topic, publicKey, record)
    }
  }
  guardPersistent()
  dht.on('persistent', guardPersistent)

  dht.hyperdhtMdns = {
    stats: state.stats,
    nodesFrom: (address) => nodesPerHost.get(hostKey(address)),
    storeOwnRecord (topic, publicKey, relayAddresses = []) {
      const key = topic.toString('hex')
      const record = c.encode(m.peer, { publicKey, relayAddresses })
      state.ownRecords.set(key, { publicKey, record })
      dht._persistent?.records.add(key, publicKey, record)
    },
    removeOwnRecord (topic, publicKey) {
      const key = topic.toString('hex')
      state.ownRecords.delete(key)
      dht._persistent?.records.remove(key, publicKey)
    },
    // Records expire after the store's maxAge; kept fresh while announced.
    refreshOwnRecords () {
      const records = dht._persistent?.records
      if (!records) return
      for (const [topic, { publicKey, record }] of state.ownRecords) {
        records.remove(topic, publicKey)
        records.add(topic, publicKey, record)
      }
    }
  }

  return dht
}

function defaultHostKey (address) {
  return address?.host || ''
}

// The handshake's payload from a server keeps only the addresses it lists
// that are local.
function localAddressesOnly (handshake, outside) {
  const recv = handshake.recv
  const filter = (payload) => {
    if (Array.isArray(payload?.addresses4)) payload.addresses4 = payload.addresses4.filter((address) => !outside(address?.host))
    return payload
  }
  handshake.recv = function (...args) {
    const payload = recv.apply(this, args)
    return typeof payload?.then === 'function' ? payload.then(filter) : filter(payload)
  }
  return handshake
}

/**
 * Whether an IPv4 address is on the local network: a private range (10/8,
 * 172.16/12, 192.168/16) or link-local (169.254/16), loopback only when
 * allowed. A network that hands out public addresses counts the bound
 * address's own /24. IPv4 written as IPv6 (::ffff:192.168.1.20) counts as
 * the IPv4 address.
 */
function localAddresses (host, { allowLoopback = false } = {}) {
  const own = ipv4(host)
  const ownSubnet = own !== null && !isPrivate(own) && !isLoopback(own) ? own >>> 8 : null
  return (address) => {
    const ip = ipv4(address)
    if (ip === null) return false
    if (isLoopback(ip)) return allowLoopback
    if (isPrivate(ip)) return true
    return ownSubnet !== null && ip >>> 8 === ownSubnet
  }
}

function ipv4 (address) {
  if (typeof address !== 'string') return null
  if (/^::ffff:/i.test(address)) address = address.slice(7)
  const parts = address.split('.')
  if (parts.length !== 4) return null
  let ip = 0
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part) || Number(part) > 255) return null
    ip = ip * 256 + Number(part)
  }
  return ip
}

function isPrivate (ip) {
  const a = Math.floor(ip / 2 ** 24)
  const b = Math.floor(ip / 2 ** 16) % 256
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254)
}

function isLoopback (ip) {
  return Math.floor(ip / 2 ** 24) === 127
}

module.exports = { createLANDHT, defaultHostKey, hardenDHT, localAddresses }
