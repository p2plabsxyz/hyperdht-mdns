'use strict'

const { createHash } = require('crypto')

const SERVICE_TYPE = 'hyperswarm-lan'
const SERVICE_PROTOCOL = 'udp'
const PROTOCOL_VERSION = 1
const TOPIC_PREFIX = Buffer.from('hyperswarm-lan:')
const TOPICS_PER_TXT_ENTRY = 5
const MAX_ADVERTISED_TOPICS = 32

function createRecord ({ peerKey, port, topics = [] }) {
  if (!Buffer.isBuffer(peerKey) || peerKey.byteLength !== 32) {
    throw new TypeError('peerKey must be a 32-byte Buffer')
  }

  assertPort(port)
  if (!Array.isArray(topics)) throw new TypeError('topics must be an array')
  if (topics.length > MAX_ADVERTISED_TOPICS) {
    throw new RangeError(`Cannot advertise more than ${MAX_ADVERTISED_TOPICS} topics`)
  }

  const peerKeyHex = peerKey.toString('hex')
  const tokens = topics.map(topicToken).sort()
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

  return {
    name: `hyperswarm-lan-${peerKeyHex.slice(0, 12)}`,
    type: SERVICE_TYPE,
    protocol: SERVICE_PROTOCOL,
    port,
    txt
  }
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

  return {
    peerKey: Buffer.from(peerKeyHex, 'hex'),
    port,
    tokens
  }
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

module.exports = {
  PROTOCOL_VERSION,
  MAX_ADVERTISED_TOPICS,
  SERVICE_PROTOCOL,
  SERVICE_TYPE,
  createRecord,
  parseRecord,
  topicToken
}
