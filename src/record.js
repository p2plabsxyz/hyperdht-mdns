'use strict'

const { createHash } = require('crypto')

const SERVICE_TYPE = 'hyperdht-mdns'
const SERVICE_PROTOCOL = 'udp'
const PROTOCOL_VERSION = 1
const TOPIC_PREFIX = Buffer.from('hyperdht-mdns:')
const TOPICS_PER_TXT_ENTRY = 5
const MAX_ADVERTISED_TOPICS = 32
const MAX_TXT_BYTES = 900

function buildTXT ({ peerKeyHex, port, tokens }) {
  const txt = {
    v: String(PROTOCOL_VERSION),
    peerKey: peerKeyHex,
    port: String(port),
    tc: String(tokens.length)
  }

  for (let i = 0; i < tokens.length; i += TOPICS_PER_TXT_ENTRY) {
    txt[`t${i / TOPICS_PER_TXT_ENTRY}`] = tokens
      .slice(i, i + TOPICS_PER_TXT_ENTRY)
      .join(',')
  }

  return txt
}

/**
 * Build the mDNS service record advertising the topics this node has joined.
 *
 * A TXT record has a hard size budget, and a 43-character token per topic
 * exhausts MAX_TXT_BYTES well before MAX_ADVERTISED_TOPICS is reached. So the
 * record advertises as many topics as fit rather than refusing to exist: a full
 * advertisement is a normal condition for a busy node, not a caller error, and
 * throwing here propagates all the way out of join() and fails whatever the
 * application was doing.
 *
 * Dropping an advertisement is cheap. Peers are matched against every joined
 * topic, not just the advertised ones, so a topic that does not fit is still
 * discoverable as long as the peer on the other side advertises it.
 *
 * The newest topics win: a peer is most likely looking for what was just
 * joined. `dropped`/`advertised` are reported so callers can surface it.
 *
 * @param {object} options
 * @param {Buffer} options.peerKey - 32-byte public key.
 * @param {number} options.port
 * @param {Buffer[]} [options.topics] - Joined topics, oldest first.
 * @returns {{ name: string, type: string, protocol: string, port: number, txt: object, advertised: number, dropped: number }}
 */
function createRecord ({ peerKey, port, topics = [] }) {
  if (!Buffer.isBuffer(peerKey) || peerKey.byteLength !== 32) {
    throw new TypeError('peerKey must be a 32-byte Buffer')
  }

  assertPort(port)
  if (!Array.isArray(topics)) throw new TypeError('topics must be an array')

  const peerKeyHex = peerKey.toString('hex')
  const tokens = topics.map(topicToken)

  // The budget depends on the port's digit count and the tN key width, so the
  // cut-off is measured rather than assumed.
  let from = Math.max(0, tokens.length - MAX_ADVERTISED_TOPICS)
  let txt = buildTXT({ peerKeyHex, port, tokens: tokens.slice(from).sort() })
  while (from < tokens.length && encodedTXTSize(txt) > MAX_TXT_BYTES) {
    from++
    txt = buildTXT({ peerKeyHex, port, tokens: tokens.slice(from).sort() })
  }

  return {
    name: `hyperdht-mdns-${peerKeyHex.slice(0, 12)}`,
    type: SERVICE_TYPE,
    protocol: SERVICE_PROTOCOL,
    port,
    txt,
    advertised: tokens.length - from,
    dropped: from
  }
}

/**
 * Build as many bounded mDNS service records as are needed to advertise every
 * joined topic. Each service instance name carries a generation, shard index,
 * and shard count so receivers can aggregate the records without spending TXT
 * bytes on bookkeeping that would otherwise displace another topic token.
 */
function createRecords ({ peerKey, port, topics = [] }) {
  if (!Buffer.isBuffer(peerKey) || peerKey.byteLength !== 32) {
    throw new TypeError('peerKey must be a 32-byte Buffer')
  }

  assertPort(port)
  if (!Array.isArray(topics)) throw new TypeError('topics must be an array')

  const peerKeyHex = peerKey.toString('hex')
  const tokens = topics.map(topicToken)
  const shards = partitionTokens({ peerKeyHex, port, tokens })
  const generation = tokenGeneration(tokens)

  return shards.map((shard, index) => ({
    name: shardName(peerKeyHex, generation, index, shards.length),
    type: SERVICE_TYPE,
    protocol: SERVICE_PROTOCOL,
    port,
    txt: buildTXT({ peerKeyHex, port, tokens: shard.slice().sort() }),
    advertised: shard.length,
    dropped: 0,
    shard: index,
    shards: shards.length,
    generation
  }))
}

function parseRecord (service) {
  if (!service || !service.txt) return null

  const version = toString(service.txt.v)
  const peerKeyHex = toString(service.txt.peerKey)
  const port = Number(service.port || toString(service.txt.port))
  const topicCount = Number(toString(service.txt.tc) || 0)

  if (version !== String(PROTOCOL_VERSION)) return null
  if (!/^[a-f0-9]{64}$/i.test(peerKeyHex)) return null
  if (!isPort(port)) return null
  if (!Number.isInteger(topicCount) || topicCount < 0 || topicCount > MAX_ADVERTISED_TOPICS) return null

  const tokens = []
  for (let i = 0; tokens.length < topicCount; i++) {
    const chunk = toString(service.txt[`t${i}`])
    if (!chunk) return null
    tokens.push(...chunk.split(','))
  }

  if (tokens.length !== topicCount || tokens.some(token => !/^[A-Za-z0-9_-]{43}$/.test(token))) {
    return null
  }
  if (new Set(tokens).size !== tokens.length) return null

  const shard = parseShardName(service.name, peerKeyHex)

  const parsed = {
    peerKey: Buffer.from(peerKeyHex, 'hex'),
    port,
    tokens
  }
  if (shard.generation !== null) {
    parsed.shard = shard.index
    parsed.shards = shard.count
    parsed.generation = shard.generation
  }
  return parsed
}

function partitionTokens ({ peerKeyHex, port, tokens }) {
  if (tokens.length === 0) return [[]]

  const shards = []
  let shard = []

  for (const token of tokens) {
    const candidate = [...shard, token]
    const txt = buildTXT({ peerKeyHex, port, tokens: candidate.slice().sort() })

    if (candidate.length > MAX_ADVERTISED_TOPICS || encodedTXTSize(txt) > MAX_TXT_BYTES) {
      shards.push(shard)
      shard = [token]
    } else {
      shard = candidate
    }
  }

  shards.push(shard)
  return shards
}

function tokenGeneration (tokens) {
  const hash = createHash('sha256')
  for (const token of tokens.slice().sort()) hash.update(token).update('\0')
  return hash.digest('base64url').slice(0, 11)
}

function shardName (peerKeyHex, generation, index, count) {
  return `hyperdht-mdns-${peerKeyHex.slice(0, 12)}-${generation}-${index}-${count}`
}

function parseShardName (name, peerKeyHex) {
  const legacy = {
    index: 0,
    count: 1,
    generation: null
  }
  if (typeof name !== 'string') return legacy

  const prefix = `hyperdht-mdns-${peerKeyHex.slice(0, 12)}-`
  if (!name.startsWith(prefix)) return legacy

  const match = /^([A-Za-z0-9_-]{11})-(\d+)-(\d+)$/.exec(name.slice(prefix.length))
  if (!match) return legacy

  const index = Number(match[2])
  const count = Number(match[3])
  if (!Number.isInteger(index) || !Number.isInteger(count) || count < 1 || count > 65535 || index < 0 || index >= count) {
    return legacy
  }

  return { generation: match[1], index, count }
}

function topicToken (topic) {
  if (!Buffer.isBuffer(topic) || topic.byteLength !== 32) {
    throw new TypeError('topic must be a 32-byte Buffer')
  }

  return createHash('sha256')
    .update(TOPIC_PREFIX)
    .update(topic)
    .digest('base64url')
}

function assertPort (port) {
  if (!isPort(port)) throw new RangeError('port must be an integer between 1 and 65535')
}

function isPort (port) {
  return Number.isInteger(port) && port > 0 && port <= 65535
}

function toString (value) {
  if (Buffer.isBuffer(value)) return value.toString()
  return typeof value === 'string' || typeof value === 'number' ? String(value) : ''
}

function encodedTXTSize (txt) {
  return Object.entries(txt).reduce((size, [key, value]) => {
    return size + Buffer.byteLength(key) + Buffer.byteLength(String(value)) + 2
  }, 0)
}

module.exports = {
  PROTOCOL_VERSION,
  MAX_ADVERTISED_TOPICS,
  MAX_TXT_BYTES,
  SERVICE_PROTOCOL,
  SERVICE_TYPE,
  createRecord,
  createRecords,
  parseRecord,
  topicToken
}
