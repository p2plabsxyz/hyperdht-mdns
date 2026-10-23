'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const HyperDHT = require('hyperdht')
const securePair = require('../test-utils/secure-pair')
const { createIdentityProof, verifyIdentityProof } = require('..')

test('a long-term key proven inside the channel is good on that connection only', async (t) => {
  const longTerm = HyperDHT.keyPair()
  const pair = await securePair()
  const other = await securePair()
  t.after(() => Promise.all([pair.close(), other.close()]))

  // The connection keys are made up; the proof says who is behind them.
  assert.equal(pair.client.publicKey.equals(longTerm.publicKey), false)

  const proof = createIdentityProof(longTerm, pair.client, 'peerchat')
  assert.deepEqual(verifyIdentityProof(proof, pair.server, 'peerchat'), longTerm.publicKey)

  // Replayed on another connection, sent back to its maker, or used for
  // another application, it proves nothing.
  assert.equal(verifyIdentityProof(proof, other.server, 'peerchat'), null)
  assert.equal(verifyIdentityProof(proof, pair.client, 'peerchat'), null)
  assert.equal(verifyIdentityProof(proof, pair.server, 'device-sync'), null)

  // A claim of someone else's key with this channel's signature fails.
  const forged = { publicKey: HyperDHT.keyPair().publicKey, signature: proof.signature }
  assert.equal(verifyIdentityProof(forged, pair.server, 'peerchat'), null)
  assert.equal(verifyIdentityProof({ publicKey: 'zz', signature: 'zz' }, pair.server, 'peerchat'), null)
  assert.equal(verifyIdentityProof(null, pair.server, 'peerchat'), null)
})

test('a proof can travel as hex, as an application would send it', async (t) => {
  const longTerm = HyperDHT.keyPair()
  const pair = await securePair()
  t.after(() => pair.close())

  const proof = createIdentityProof(longTerm, pair.server)
  const sent = { publicKey: proof.publicKey.toString('hex'), signature: proof.signature.toString('hex') }
  assert.deepEqual(verifyIdentityProof(sent, pair.client), longTerm.publicKey)
  assert.throws(() => createIdentityProof({ publicKey: longTerm.publicKey }, pair.server))
})
