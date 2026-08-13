'use strict'

const net = require('net')
const os = require('os')

function selectLocalIPv4 (interfaces = os.networkInterfaces(), allowLoopback = false) {
  const addresses = []

  for (const entries of Object.values(interfaces)) {
    for (const entry of entries || []) {
      const family = typeof entry.family === 'string' ? entry.family : `IPv${entry.family}`
      if (family !== 'IPv4') continue
      if (entry.internal && !allowLoopback) continue
      if (net.isIPv4(entry.address)) addresses.push(entry.address)
    }
  }

  addresses.sort((a, b) => addressPriority(a) - addressPriority(b))

  if (addresses.length > 0) return addresses[0]
  if (allowLoopback) return '127.0.0.1'

  throw new Error('No non-loopback IPv4 LAN interface is available')
}

function serviceIPv4 (service) {
  const candidates = []

  if (service && service.referer && service.referer.address) {
    candidates.push(service.referer.address)
  }

  if (service && Array.isArray(service.addresses)) {
    candidates.push(...service.addresses)
  }

  for (const candidate of candidates) {
    const address = normalizeIPv4(candidate)
    if (address && address !== '0.0.0.0') return address
  }

  return null
}

function normalizeIPv4 (address) {
  if (typeof address !== 'string') return null
  if (address.startsWith('::ffff:')) address = address.slice(7)
  return net.isIPv4(address) ? address : null
}

function addressPriority (address) {
  if (address.startsWith('192.168.')) return 0
  if (address.startsWith('10.')) return 1

  const second = Number(address.split('.')[1])
  if (address.startsWith('172.') && second >= 16 && second <= 31) return 2
  if (address.startsWith('169.254.')) return 4
  if (address.startsWith('127.')) return 5
  return 3
}

module.exports = {
  normalizeIPv4,
  selectLocalIPv4,
  serviceIPv4
}
