'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { createRecord, parseRecord, topicToken } = require('../src/record')

test('creates and parses hashed topic tokens in a node-level mDNS record', () => {
  const peerKey = Buffer.alloc(32, 7)
  const topics = [Buffer.alloc(32, 8), Buffer.alloc(32, 9)]
  const advertised = createRecord({ peerKey, port: 49799, topics })
  const parsed = parseRecord(advertised)

  assert.equal(advertised.type, 'hyperdht-mdns')
  assert.equal(advertised.protocol, 'udp')
  assert.deepEqual(parsed, {
    peerKey,
    port: 49799,
    tokens: topics.map(topicToken).sort()
  })
  assert.equal(JSON.stringify(advertised.txt).includes(topics[0].toString('hex')), false)
})

test('caps TXT records below the multicast packet budget', () => {
  assert.throws(() => {
    createRecord({
      peerKey: Buffer.alloc(32, 1),
      port: 49799,
      topics: Array.from({ length: 32 }, (_, index) => Buffer.alloc(32, index))
    })
  }, /TXT record exceeds/)
})

test('rejects unsupported or malformed records', () => {
  assert.equal(parseRecord({ port: 1, txt: { v: '2', peerKey: 'a'.repeat(64) } }), null)
  assert.equal(parseRecord({ port: 1, txt: { v: '1', peerKey: 'not-a-key' } }), null)
  assert.equal(parseRecord({ port: 0, txt: { v: '1', peerKey: 'a'.repeat(64) } }), null)
  assert.equal(parseRecord({
    port: 1,
    txt: { v: '1', peerKey: 'a'.repeat(64), tc: '1', t0: 'raw-topic' }
  }), null)
})
