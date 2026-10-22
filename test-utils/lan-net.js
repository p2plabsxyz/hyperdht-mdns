'use strict'

const HyperDHTmDNS = require('..')
const MemoryAdapter = require('./memory-adapter')

/**
 * Devices on one simulated LAN: real LAN DHT nodes on loopback, with mDNS in
 * memory. Limits default to fast timers so tests run in milliseconds.
 */
async function createLAN (count, { basePort, limits = {}, hostKey, bus = new Set(), ready = true, opts = {} } = {}) {
  const nodes = []
  for (let i = 0; i < count; i++) nodes.push(createNode({ port: basePort + i, bus, limits, hostKey, opts }))
  if (ready) await Promise.all(nodes.map((node) => node.ready()))
  return {
    nodes,
    bus,
    add (port, extra = {}) {
      const node = createNode({ port, bus, limits, hostKey, opts: { ...opts, ...extra } })
      nodes.push(node)
      return node
    },
    destroy: () => Promise.allSettled(nodes.map((node) => node.destroy()))
  }
}

function createNode ({ port, bus, limits, hostKey, opts }) {
  return new HyperDHTmDNS({
    host: '127.0.0.1',
    port,
    allowLoopback: true,
    adapter: new MemoryAdapter(bus),
    hostKey,
    ...opts,
    limits: { sweepInterval: 50, ...limits, ...opts.limits }
  })
}

function nextConnection (node) {
  return new Promise((resolve) => {
    node.once('connection', (socket, info) => {
      socket.on('error', () => {})
      resolve([socket, info])
    })
  })
}

async function until (check, { timeout = 10_000, interval = 25, label = 'condition' } = {}) {
  const started = Date.now()
  while (Date.now() - started < timeout) {
    const value = await check()
    if (value) return value
    await new Promise((resolve) => setTimeout(resolve, interval))
  }
  throw new Error(`timed out waiting for ${label}`)
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

module.exports = { createLAN, createNode, nextConnection, until, sleep }
