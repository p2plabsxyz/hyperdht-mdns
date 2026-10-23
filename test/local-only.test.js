'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { randomBytes } = require('crypto')
const HyperDHT = require('hyperdht')
const HyperDHTmDNS = require('..')
const { localAddresses } = require('../src/lan-dht')
const MemoryAdapter = require('../test-utils/memory-adapter')

// Ports 21450-21459.

test('only private, link-local and (when allowed) loopback addresses are local', () => {
  const isLocal = localAddresses('192.168.1.20')
  for (const host of ['10.0.0.4', '172.16.0.1', '172.31.255.254', '192.168.1.99', '169.254.10.20']) assert.equal(isLocal(host), true, host)
  for (const host of ['8.8.8.8', '172.32.0.1', '100.64.0.1', '203.0.113.7', '127.0.0.1', '::1', '', 'x', '1.2.3', '1.2.3.400', undefined]) {
    assert.equal(isLocal(host), false, String(host))
  }
  assert.equal(localAddresses('127.0.0.1', { allowLoopback: true })('127.0.0.1'), true)
  // A network that hands out public addresses: its own /24 only.
  const campus = localAddresses('198.51.100.20')
  assert.equal(campus('198.51.100.77'), true)
  assert.equal(campus('198.51.101.77'), false)
})

// A node elsewhere on the network that has internet nodes in its table, as a
// LAN DHT that leaked would. Its answers name one; this device must neither
// take it nor send it anything, and a request from outside goes unanswered.
test('the LAN DHT takes nothing from outside the local network and sends nothing there', async (t) => {
  const outside = { host: '203.0.113.7', port: 49737 }
  const leaky = HyperDHT.bootstrapper(21450, '127.0.0.1', { bootstrap: [] })
  await leaky.fullyBootstrapped()
  leaky.addNode(outside)
  const lan = new HyperDHTmDNS({ host: '127.0.0.1', port: 21451, allowLoopback: true, adapter: new MemoryAdapter(new Set()) })
  lan.on('warning', () => {})
  t.after(async () => {
    await lan.destroy()
    await leaky.destroy()
  })
  await lan.ready()

  lan.dht.addNode({ host: '127.0.0.1', port: 21450 })
  for await (const reply of lan.dht.findNode(randomBytes(32))) assert.ok(reply)
  assert.deepEqual(lan.dht.toArray().map((node) => node.host), ['127.0.0.1'])
  assert.ok(lan.info().stats.outsideDropped > 0, 'the leaky node did name the outside one')

  lan.dht.addNode(outside)
  assert.equal(lan.dht.toArray().some((node) => node.host === outside.host), false)
  await assert.rejects(lan.dht.ping(outside))

  let answered = false
  const dropped = lan.info().stats.outsideDropped
  lan.dht.io.onrequest({ from: { ...outside, id: randomBytes(32) }, reply () { answered = true } }, true)
  assert.equal(answered, false)
  assert.equal(lan.info().stats.outsideDropped, dropped + 1)
})
