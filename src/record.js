'use strict'

const { randomBytes } = require('crypto')

const SERVICE_TYPE = 'hyperdht-mdns'
const SERVICE_PROTOCOL = 'udp'
const PROTOCOL_VERSION = 2
const NAME_PATTERN = /^[a-z0-9]{16}$/

/**
 * A device's mDNS record. It says only that a device of this kind is at this
 * address and port, under a name made up for this run: no device key and no
 * topics, so a passive listener on the network learns neither who the device
 * is nor what it is in, and cannot link it to the same device on another day
 * or another network. Topics are found through the LAN DHT, which needs the
 * topic to ask for it.
 *
 * Version 1 records carried the device's network key and a hash of every
 * joined topic. They are ignored.
 *
 * @param {object} options
 * @param {number} options.port - The LAN DHT's UDP port.
 * @param {string} [options.name] - Instance name; a fresh random one by default.
 */
function createRecord ({ port, name = randomName() } = {}) {
  assertPort(port)
  if (!NAME_PATTERN.test(name)) throw new TypeError('name must be 16 lowercase letters or digits')

  return {
    name,
    type: SERVICE_TYPE,
    protocol: SERVICE_PROTOCOL,
    port,
    txt: { v: String(PROTOCOL_VERSION) }
  }
}

/** The name and port a service announces, or null for anything else. */
function parseRecord (service) {
  if (!service || !service.txt) return null

  const version = toString(service.txt.v)
  if (version !== String(PROTOCOL_VERSION)) return null

  const name = typeof service.name === 'string' ? service.name.toLowerCase() : ''
  if (!NAME_PATTERN.test(name)) return null

  const port = Number(service.port)
  if (!isPort(port)) return null

  return { name, port }
}

/** Sixteen random lowercase letters and digits. */
function randomName () {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789'
  const bytes = randomBytes(16)
  let name = ''
  // 36 does not divide 256, so bytes past the last whole multiple are skipped
  // to keep every character equally likely.
  for (let i = 0; name.length < 16; i++) {
    if (i === bytes.length) return name + randomName().slice(name.length)
    if (bytes[i] >= 252) continue
    name += alphabet[bytes[i] % 36]
  }
  return name
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
  NAME_PATTERN,
  PROTOCOL_VERSION,
  SERVICE_PROTOCOL,
  SERVICE_TYPE,
  createRecord,
  parseRecord,
  randomName
}
