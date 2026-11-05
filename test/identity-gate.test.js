'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { randomBytes } = require('crypto')
const HyperDHT = require('hyperdht')
const Protomux = require('protomux')
const c = require('compact-encoding')
const sodium = require('sodium-universal')
const securePair = require('../test-utils/secure-pair')
const { until, sleep } = require('../test-utils/lan-net')
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

test('a token list over the cap of 512 closes the gate without being read, and 512 are still read', async (t) => {
  for (const [count, read] of [[512, true], [513, false], [600, false]]) {
    const pair = await securePair()
    t.after(() => pair.close())
    const room = randomBytes(32)

    // The other side sends a list with the real token among random ones.
    const seen = { identity: [], closed: false }
    const channel = Protomux.from(pair.server).createChannel({
      protocol: PROTOCOL,
      id: Buffer.from('peerchat'),
      onclose () { seen.closed = true }
    })
    const tokens = channel.addMessage({ encoding: c.array(c.fixed32) })
    channel.addMessage({
      encoding: c.raw,
      onmessage (value) {
        seen.identity.push(value)
        channel.close()
      }
    })
    channel.open()

    const started = Date.now()
    const gate = identityGate(pair.client, { keyPair: HyperDHT.keyPair(), secrets: [room], context: 'peerchat', timeout: 5000 })
    const list = Array.from({ length: count }, () => randomBytes(32))
    list[count >> 1] = token(room, pair.server, 'peerchat')
    tokens.send(list)

    assert.equal(await gate, null)
    assert.ok(Date.now() - started < 2000, 'well before the timeout')
    if (read) {
      // Matched, so this side, which opened the connection, proved itself.
      assert.equal(seen.identity.length, 1)
      assert.equal(seen.identity[0][0], 1)
    } else {
      assert.deepEqual(seen.identity, [])
      await until(() => seen.closed, { label: 'the gate to close its channel' })
    }
    // The connection itself is left alone.
    assert.equal(pair.client.destroying, false)
    assert.equal(pair.server.destroying, false)
  }
})

test('someone who holds the secret and declines learns nothing from the side that proves second', async (t) => {
  const pair = await securePair()
  t.after(() => pair.close())
  const room = randomBytes(32)

  // The client opened the connection, so it would prove first. It holds the
  // room key but sends no proof.
  const seen = { tokens: null, identity: [] }
  const channel = Protomux.from(pair.client).createChannel({ protocol: PROTOCOL, id: Buffer.from('peerchat') })
  const tokens = channel.addMessage({ encoding: c.array(c.fixed32), onmessage (value) { seen.tokens = value } })
  const identity = channel.addMessage({ encoding: c.raw, onmessage (value) { seen.identity.push(value) } })
  channel.open()

  const gate = identityGate(pair.server, { keyPair: HyperDHT.keyPair(), secrets: [room], context: 'peerchat' })
  tokens.send([token(room, pair.client, 'peerchat'), ...Array.from({ length: 15 }, () => randomBytes(32))])
  await until(() => seen.tokens, { label: 'the member\'s tokens' })
  // It learns that the other side holds the room key, as the tokens say.
  assert.ok(seen.tokens.some((value) => value.equals(token(room, pair.server, 'peerchat'))))
  identity.send(Buffer.from([0]))

  assert.equal(await gate, null)
  await sleep(100)
  // And not who it is: the member never proved.
  assert.deepEqual(seen.identity, [])
})

test('the side that proves second proves only to a key it accepts', async (t) => {
  const room = randomBytes(32)
  const alice = HyperDHT.keyPair()
  const bob = HyperDHT.keyPair()

  for (const yes of [false, true]) {
    const pair = await securePair()
    t.after(() => pair.close())
    const asked = []
    // Alice opened the connection, so she proves first; Bob checks her key.
    const [atAlice, atBob] = await Promise.all([
      identityGate(pair.client, { keyPair: alice, secrets: [room], context: 'peerchat' }),
      identityGate(pair.server, {
        keyPair: bob,
        secrets: [room],
        context: 'peerchat',
        async accept (publicKey, matches) {
          asked.push({ publicKey, matches })
          return yes
        }
      })
    ])
    assert.deepEqual(asked, [{ publicKey: alice.publicKey, matches: [0] }])
    if (yes) {
      assert.deepEqual(atAlice.publicKey, bob.publicKey)
      assert.deepEqual(atBob.publicKey, alice.publicKey)
    } else {
      assert.equal(atAlice, null)
      assert.equal(atBob, null)
    }
  }
})

// A gate token as the module makes it, written out here so that a change to
// what goes on the wire fails a test.
function token (secret, stream, context) {
  const out = Buffer.alloc(32)
  sodium.crypto_generichash_batch(out, [
    Buffer.from('hyperdht-mdns/identity-gate/1\n'),
    Buffer.from(context + '\n'),
    stream.handshakeHash,
    stream.publicKey
  ], secret)
  return out
}
