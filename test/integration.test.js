'use strict'

const { randomBytes } = require('crypto')
const { rm } = require('fs/promises')
const { tmpdir } = require('os')
const path = require('path')
const test = require('node:test')
const assert = require('node:assert/strict')
const createTestnet = require('hyperdht/testnet')
const { attachHyperSDK, identityGate } = require('..')
const MemoryAdapter = require('../test-utils/memory-adapter')
const { until } = require('../test-utils/lan-net')

// Ports 21600-21699.

async function device (t, { bus, lanPort, internet = null, limits = {} }) {
  const { create } = await import('hyper-sdk')
  const storage = path.join(tmpdir(), `hyperdht-mdns-it-${randomBytes(6).toString('hex')}`)
  const sdk = await create({
    storage,
    // The internet: a testnet when there is one, otherwise no DHT at all.
    swarmOpts: internet ? { bootstrap: internet.bootstrap } : { bootstrap: [] }
  })
  const lanOptions = {
    host: '127.0.0.1',
    port: lanPort,
    allowLoopback: true,
    adapter: new MemoryAdapter(bus),
    limits: { sweepInterval: 50, ...limits }
  }
  await attachHyperSDK(sdk, lanOptions)
  t.after(async () => {
    await sdk.close().catch(() => {})
    await rm(storage, { recursive: true, force: true })
  })
  return { sdk, lanOptions }
}

// Whether a copy has caught up to length, after asking the network.
async function caughtUp (copy, length, opts) {
  await copy.update(opts).catch(() => {})
  return copy.length === length
}

// A device leaves the Wi-Fi: its LAN instance goes without a goodbye.
async function leaveWifi (sdk) {
  sdk.localSwarm.adapter.vanish()
  await sdk.localSwarm.destroy()
}

// And comes back: a new LAN instance, as the apps make after a network change.
async function rejoinWifi (sdk, lanOptions, bus) {
  return attachHyperSDK(sdk, { ...lanOptions, adapter: new MemoryAdapter(bus) })
}

test('two devices replicate a core over the LAN, on keys made up for the network', { timeout: 60_000 }, async (t) => {
  const bus = new Set()
  const { sdk: writer } = await device(t, { bus, lanPort: 21600 })
  const { sdk: reader } = await device(t, { bus, lanPort: 21601 })

  const seen = []
  reader.swarm.on('connection', (socket, info) => seen.push(info))

  const core = writer.corestore.get({ name: 'messages' })
  await core.ready()
  await core.append(['one', 'two', 'three'].map((text) => Buffer.from(text)))
  await writer.joinCore(core)

  const copy = reader.corestore.get({ key: core.key })
  await copy.ready()
  await reader.joinCore(copy)
  await until(() => caughtUp(copy, 3), { label: 'replication' })
  assert.equal((await copy.get(2)).toString(), 'three')

  const lan = seen.find((info) => info.lan)
  assert.ok(lan, 'a LAN connection reached the SDK')
  assert.equal(lan.ephemeral, true)
  assert.equal(reader.localSwarm.keyPair.publicKey.equals(reader.swarm.keyPair.publicKey), false)
  assert.equal(writer.localSwarm.keyPair.publicKey.equals(writer.swarm.keyPair.publicKey), false)
})

test('a device that drops off the Wi-Fi and comes back gets everything written meanwhile', { timeout: 90_000 }, async (t) => {
  const bus = new Set()
  const { sdk: writer } = await device(t, { bus, lanPort: 21610 })
  const { sdk: reader, lanOptions } = await device(t, { bus, lanPort: 21611 })

  const core = writer.corestore.get({ name: 'log' })
  await core.ready()
  await core.append(Buffer.from('before'))
  await writer.joinCore(core)
  const copy = reader.corestore.get({ key: core.key })
  await copy.ready()
  await reader.joinCore(copy)
  await until(() => caughtUp(copy, 1), { label: 'first block' })
  const firstKey = reader.localSwarm.keyPair.publicKey

  for (let cycle = 0; cycle < 2; cycle++) {
    // Airplane mode on.
    await leaveWifi(reader)
    for (let i = 0; i < 25; i++) await core.append(Buffer.from(`while away ${cycle}.${i}`))
    await new Promise((resolve) => setTimeout(resolve, 300))
    assert.ok(copy.length < core.length, 'nothing arrives while away')

    // Airplane mode off.
    const lan = await rejoinWifi(reader, lanOptions, bus)
    assert.equal(lan.keyPair.publicKey.equals(firstKey), false, 'a new key on coming back')
    await until(() => caughtUp(copy, core.length, { wait: true }), { timeout: 30_000, label: `catching up ${cycle}` })
    assert.equal((await copy.get(core.length - 1)).toString(), `while away ${cycle}.24`)
  }
})

test('a device that moves from the Wi-Fi to the internet keeps syncing, and the LAN lets it go', { timeout: 120_000 }, async (t) => {
  const internet = await createTestnet(3, { host: '127.0.0.1', port: 21690 })
  t.after(() => internet.destroy())
  const bus = new Set()
  const limits = { deviceTTL: 300, pingInterval: 200 }
  const { sdk: writer } = await device(t, { bus, lanPort: 21620, internet, limits })
  const { sdk: reader } = await device(t, { bus, lanPort: 21621, internet, limits })

  const core = writer.corestore.get({ name: 'feed' })
  await core.ready()
  await core.append(Buffer.from('on the wifi'))
  await writer.joinCore(core)
  const copy = reader.corestore.get({ key: core.key })
  await copy.ready()
  await reader.joinCore(copy)
  await until(() => caughtUp(copy, 1), { label: 'first block' })
  await until(() => writer.localSwarm.info().devices === 1, { label: 'writer to see the reader on the LAN' })

  // The reader leaves the Wi-Fi for the internet.
  await leaveWifi(reader)
  await core.append(Buffer.from('over the internet'))
  await until(() => caughtUp(copy, 2, { wait: true }), { timeout: 60_000, label: 'internet sync' })
  assert.equal((await copy.get(1)).toString(), 'over the internet')

  // The writer's LAN view drops the device that is gone.
  await until(() => writer.localSwarm.info().devices === 0, { timeout: 20_000, label: 'LAN to drop the reader' })
})

test('two members prove who they are inside a LAN connection; the network never sees it', { timeout: 60_000 }, async (t) => {
  const bus = new Set()
  const { sdk: a } = await device(t, { bus, lanPort: 21630 })
  const { sdk: b } = await device(t, { bus, lanPort: 21631 })
  const room = randomBytes(32)

  const connected = new Promise((resolve) => a.swarm.on('connection', (socket, info) => { if (info.lan) resolve(socket) }))
  const otherSide = new Promise((resolve) => b.swarm.on('connection', (socket, info) => { if (info.lan) resolve(socket) }))
  const topic = randomBytes(32)
  a.join(topic)
  b.join(topic)
  const [socketA, socketB] = await Promise.all([connected, otherSide])
  assert.equal(socketA.remotePublicKey.equals(b.swarm.keyPair.publicKey), false)

  const [atA, atB] = await Promise.all([
    identityGate(socketA, { keyPair: a.swarm.keyPair, secrets: [room], context: 'peerchat' }),
    identityGate(socketB, { keyPair: b.swarm.keyPair, secrets: [room], context: 'peerchat' })
  ])
  assert.deepEqual(atA.publicKey, b.swarm.keyPair.publicKey)
  assert.deepEqual(atB.publicKey, a.swarm.keyPair.publicKey)
})
