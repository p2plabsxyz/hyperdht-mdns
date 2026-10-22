'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { randomBytes } = require('crypto')
const HyperDHT = require('hyperdht')
const Protomux = require('protomux')
const c = require('compact-encoding')
const securePair = require('../test-utils/secure-pair')
const { identityGate } = require('..')
const { PROTOCOL } = require('../src/identity-gate')

test('two members of one room learn who the other is, and nothing else', async (t) => {
  const pair = await securePair()
  t.after(() => pair.close())
  const room = randomBytes(32)
  const alice = HyperDHT.keyPair()
  const bob = HyperDHT.keyPair()

  const [atAlice, atBob] = await Promise.all([
    identityGate(pair.client, { keyPair: alice, secrets: [randomBytes(32), room, randomBytes(32)], context: 'peerchat' }),
    identityGate(pair.server, { keyPair: bob, secrets: [room], context: 'peerchat' })
  ])

  assert.deepEqual(atAlice.publicKey, bob.publicKey)
  assert.deepEqual(atAlice.matches, [1])
  assert.deepEqual(atBob.publicKey, alice.publicKey)
  assert.deepEqual(atBob.matches, [0])
})

test('without a shared secret neither side says who it is', async (t) => {
  const pair = await securePair()
  t.after(() => pair.close())

  const results = await Promise.all([
    identityGate(pair.client, { keyPair: HyperDHT.keyPair(), secrets: [randomBytes(32)] }),
    identityGate(pair.server, { keyPair: HyperDHT.keyPair(), secrets: [randomBytes(32), randomBytes(32)] })
  ])
  assert.deepEqual(results, [null, null])
})

test('a stranger who only knows the topic, not the room key, learns nothing', async (t) => {
  const pair = await securePair()
  t.after(() => pair.close())
  const room = randomBytes(32)
  const member = HyperDHT.keyPair()

  // The stranger watches the gate's messages and proves nothing back.
  const seen = { tokens: null, identity: undefined }
  const channel = Protomux.from(pair.server).createChannel({ protocol: PROTOCOL, id: Buffer.from('peerchat') })
  const tokens = channel.addMessage({ encoding: c.array(c.fixed32), onmessage (value) { seen.tokens = value } })
  channel.addMessage({ encoding: c.raw, onmessage (value) { seen.identity = value } })
  channel.open()

  const gate = identityGate(pair.client, { keyPair: member, secrets: [room], context: 'peerchat', timeout: 1000 })
  await new Promise((resolve) => setTimeout(resolve, 200))
  // Random tokens, as from someone with no matching secret.
  tokens.send(Array.from({ length: 16 }, () => randomBytes(32)))

  assert.equal(await gate, null)
  await new Promise((resolve) => setTimeout(resolve, 200))
  // The member's tokens were padded, and it declined to say who it is.
  assert.equal(seen.tokens.length, 16)
  assert.equal(seen.tokens.some((token) => token.equals(room)), false)
  assert.deepEqual(seen.identity, Buffer.from([0]))
})

test('the tokens for the same secret differ on every connection, so they cannot be followed', async (t) => {
  const first = await securePair()
  const second = await securePair()
  t.after(() => Promise.all([first.close(), second.close()]))
  const room = randomBytes(32)

  const capture = (stream) => new Promise((resolve) => {
    const channel = Protomux.from(stream).createChannel({ protocol: PROTOCOL, id: Buffer.from('') })
    channel.addMessage({ encoding: c.array(c.fixed32), onmessage: resolve })
    channel.addMessage({ encoding: c.raw })
    channel.open()
  })

  const [a, b] = await Promise.all([
    capture(first.server),
    capture(second.server),
    identityGate(first.client, { keyPair: HyperDHT.keyPair(), secrets: [room], timeout: 300 }),
    identityGate(second.client, { keyPair: HyperDHT.keyPair(), secrets: [room], timeout: 300 })
  ])
  const hex = (tokens) => new Set(tokens.map((token) => token.toString('hex')))
  const overlap = [...hex(a)].filter((token) => hex(b).has(token))
  assert.deepEqual(overlap, [])
})

test('a side that does not run the gate leaves it at null after the timeout', async (t) => {
  const pair = await securePair()
  t.after(() => pair.close())
  const started = Date.now()
  const result = await identityGate(pair.client, { keyPair: HyperDHT.keyPair(), secrets: [randomBytes(32)], timeout: 300 })
  assert.equal(result, null)
  assert.ok(Date.now() - started < 2000)
})

test('gates for different applications on one connection do not mix', async (t) => {
  const pair = await securePair()
  t.after(() => pair.close())
  const room = randomBytes(32)
  const link = randomBytes(32)
  const a = HyperDHT.keyPair()
  const b = HyperDHT.keyPair()

  const [chatA, chatB, syncA, syncB] = await Promise.all([
    identityGate(pair.client, { keyPair: a, secrets: [room], context: 'peerchat' }),
    identityGate(pair.server, { keyPair: b, secrets: [room], context: 'peerchat' }),
    identityGate(pair.client, { keyPair: a, secrets: [link], context: 'device-sync' }),
    identityGate(pair.server, { keyPair: b, secrets: [randomBytes(32)], context: 'device-sync', timeout: 1000 })
  ])
  assert.deepEqual(chatA.publicKey, b.publicKey)
  assert.deepEqual(chatB.publicKey, a.publicKey)
  assert.equal(syncA, null)
  assert.equal(syncB, null)
})

test('a key pair and secrets still loading are waited for, with the channel open from the start', async (t) => {
  const pair = await securePair()
  t.after(() => pair.close())
  const room = randomBytes(32)
  const alice = HyperDHT.keyPair()
  const bob = HyperDHT.keyPair()
  const later = (value, ms) => new Promise((resolve) => setTimeout(() => resolve(value), ms))

  const [atAlice, atBob] = await Promise.all([
    identityGate(pair.client, { keyPair: later(alice, 150), secrets: later([room], 50), context: 'peerchat' }),
    identityGate(pair.server, { keyPair: bob, secrets: [room], context: 'peerchat' })
  ])
  assert.deepEqual(atAlice.publicKey, bob.publicKey)
  assert.deepEqual(atBob.publicKey, alice.publicKey)
})

test('a device with no key pair to prove with learns nothing either', async (t) => {
  const pair = await securePair()
  t.after(() => pair.close())
  const room = randomBytes(32)

  const results = await Promise.all([
    identityGate(pair.client, { keyPair: Promise.resolve(null), secrets: [room], context: 'peerchat' }),
    identityGate(pair.server, { keyPair: HyperDHT.keyPair(), secrets: [room], context: 'peerchat' })
  ])
  assert.deepEqual(results, [null, null])
})
