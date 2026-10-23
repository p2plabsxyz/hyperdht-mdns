'use strict'

const HyperDHT = require('hyperdht')
const c = require('compact-encoding')
const m = require('hyperdht/lib/messages')
const { Counter, RateLimiter } = require('./limits')

/**
 * The isolated DHT a device runs on the local network, made hard to take
 * over or knock down from one machine on the same Wi-Fi:
 *
 * - at most `nodesPerIP` routing table entries come from one IP address, so
 *   one machine running many DHT nodes cannot fill this device's view of the
 *   network (dht-rpc derives node ids from address and port, so a machine
 *   gets more ids only by opening more ports);
 * - requests are rate limited per sender and overall;
 * - topic announcements are rate limited per sender and per sender and
 *   topic, so one machine cannot drown a topic in fake peers, and the record
 *   store is smaller than on the internet;
 * - this device answers lookups for the topics it announces itself. With two
 *   or three devices, each one's announcement is stored only on the others,
 *   and a lookup never asks the node it runs on, so two devices could not
 *   find each other through the DHT alone;
 * - nothing outside the local network gets in or out (localAddresses). The
 *   node is reachable the way an internet DHT node is, and once a packet from
 *   its port has crossed the router, the router's UDP mapping lets internet
 *   nodes reach it; one that adds it shares it with others, and with no
 *   such check it joins the internet DHT and takes this network's
 *   announcements there.
 */
function createLANDHT ({ port, host, keyPair, limits, dhtOptions = {}, hostKey = defaultHostKey, allowLoopback = false }) {
  const dht = HyperDHT.bootstrapper(port, host, {
    maxSize: limits.records,
    ...dhtOptions,
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

  // Closer nodes outside are left out of every answer before a query sees
  // them, and nothing is sent outside: a request there is not made, which an
  // explicit ping or request reports as an error. Requests from outside go
  // unanswered (below, ahead of the rate limits).
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
    if (!isLocal(node?.host)) {
      state.stats.outsideDropped++
      return
    }
    addNode(node)
  }
  const createRequest = dht.io.createRequest.bind(dht.io)
  dht.io.createRequest = (to, ...rest) => {
    if (!isLocal(to?.host)) {
      state.stats.outsideDropped++
      return null
    }
    return createRequest(to, ...rest)
  }

  // Counted from the table itself, so nodes dropped for not answering free
  // their place for someone else on that address.
  dht.on('add-node', (node) => nodesPerHost.add(hostKey(node)))
  dht.on('remove-node', (node) => nodesPerHost.remove(hostKey(node)))

  const filterNode = dht._filterNode
  dht._filterNode = (node) => {
    if (!isLocal(node.host)) {
      state.stats.outsideDropped++
      return false
    }
    if (filterNode && !filterNode(node)) return false
    // A node already in the table is only being refreshed.
    if (node.id && dht.table.get(node.id)) return true
    if (nodesPerHost.get(hostKey(node)) >= limits.nodesPerIP) {
      state.stats.refusedNodes++
      return false
    }
    return true
  }

  const perSender = new RateLimiter({ rate: limits.requestsPerSecond, burst: limits.requestBurst })
  const overall = new RateLimiter({ rate: limits.requestsPerSecondTotal, burst: limits.requestsPerSecondTotal })
  const onrequest = dht.io.onrequest
  dht.io.onrequest = (req, external) => {
    if (!perSender.take(hostKey(req.from)) || !overall.take('all')) {
      state.stats.droppedRequests++
      return
    }
    onrequest(req, external)
  }
  // Outermost, so a request from outside costs nothing, not even a place in
  // the rate limits.
  const onrequestLimited = dht.io.onrequest
  dht.io.onrequest = (req, external) => {
    if (!isLocal(req.from?.host)) {
      state.stats.outsideDropped++
      return
    }
    onrequestLimited(req, external)
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

/**
 * Whether an IPv4 address is on the local network: a private range (10/8,
 * 172.16/12, 192.168/16) or link-local (169.254/16), loopback only when
 * allowed. A network that hands out public addresses counts the bound
 * address's own /24.
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
