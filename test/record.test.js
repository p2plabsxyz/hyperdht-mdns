'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { createRecord, parseRecord, topicToken, MAX_TXT_BYTES } = require('../src/record')

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

function txtSize (txt) {
  return Object.entries(txt).reduce(
    (size, [key, value]) => size + Buffer.byteLength(key) + Buffer.byteLength(String(value)) + 2,
    0
  )
}

test('advertises as many topics as fit in the multicast packet budget', () => {
  const peerKey = Buffer.alloc(32, 1)
  const topics = Array.from({ length: 32 }, (_, index) => Buffer.alloc(32, index))
  const record = createRecord({ peerKey, port: 49799, topics })

  assert.ok(txtSize(record.txt) <= MAX_TXT_BYTES)
  assert.ok(record.advertised > 0)
  assert.equal(record.advertised + record.dropped, topics.length)
  assert.equal(Number(record.txt.tc), record.advertised)

  // A trimmed record is still a valid record: peers parse it unchanged.
  const parsed = parseRecord(record)
  assert.equal(parsed.tokens.length, record.advertised)
})

test('never refuses to build a record, however many topics are joined', () => {
  const peerKey = Buffer.alloc(32, 1)

  for (const count of [1, 15, 18, 19, 32, 200]) {
    const topics = Array.from({ length: count }, (_, index) =>
      Buffer.alloc(32, index % 256)
    )
    const record = createRecord({ peerKey, port: 49799, topics })

    assert.ok(txtSize(record.txt) <= MAX_TXT_BYTES, `record too large at ${count} topics`)
    assert.notEqual(parseRecord(record), null, `record unparseable at ${count} topics`)
    assert.equal(record.advertised + record.dropped, count)
  }
})

test('keeps the most recently joined topics when the record is full', () => {
  const peerKey = Buffer.alloc(32, 1)
  const topics = Array.from({ length: 40 }, (_, index) => Buffer.alloc(32, index))
  const record = createRecord({ peerKey, port: 49799, topics })

  assert.ok(record.dropped > 0, 'expected this many topics to overflow the record')

  const advertised = new Set(parseRecord(record).tokens)
  const newest = topics.slice(-record.advertised).map(topicToken)
  const oldest = topics.slice(0, record.dropped).map(topicToken)

  assert.ok(newest.every((token) => advertised.has(token)), 'newest topics were dropped')
  assert.ok(oldest.every((token) => !advertised.has(token)), 'oldest topics were kept')
})

test('advertises every topic when they all fit', () => {
  const peerKey = Buffer.alloc(32, 1)
  const topics = [Buffer.alloc(32, 1), Buffer.alloc(32, 2)]
  const record = createRecord({ peerKey, port: 49799, topics })

  assert.equal(record.dropped, 0)
  assert.equal(record.advertised, 2)
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
