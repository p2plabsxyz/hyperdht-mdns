'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { createRecord, parseRecord, randomName, PROTOCOL_VERSION } = require('../src/record')

test('a record says only that a device is at a port, under a made-up name', () => {
  const record = createRecord({ port: 49799 })

  assert.equal(record.type, 'hyperdht-mdns')
  assert.equal(record.protocol, 'udp')
  assert.equal(record.port, 49799)
  assert.match(record.name, /^[a-z0-9]{16}$/)
  // No key and no topics: the version is the only thing in the TXT record.
  assert.deepEqual(record.txt, { v: String(PROTOCOL_VERSION) })
  assert.deepEqual(parseRecord(record), { name: record.name, port: 49799 })
})

test('names are random, so one run cannot be linked to the next', () => {
  const names = new Set(Array.from({ length: 2000 }, () => randomName()))
  assert.equal(names.size, 2000)
  for (const name of names) assert.match(name, /^[a-z0-9]{16}$/)
})

test('version 1 records, which carried the device key and topic hashes, are ignored', () => {
  const v1 = {
    name: 'hyperdht-mdns-0707070707-abcdefghijk-0-1',
    port: 49799,
    txt: { v: '1', peerKey: '07'.repeat(32), port: '49799', tc: '0' }
  }
  assert.equal(parseRecord(v1), null)
})

test('rejects records that are not well formed', () => {
  const good = createRecord({ port: 49799 })
  assert.equal(parseRecord(null), null)
  assert.equal(parseRecord({ ...good, txt: undefined }), null)
  assert.equal(parseRecord({ ...good, txt: { v: '3' } }), null)
  assert.equal(parseRecord({ ...good, name: 'Akhileshs-MacBook' }), null)
  assert.equal(parseRecord({ ...good, port: 0 }), null)
  assert.equal(parseRecord({ ...good, port: 70000 }), null)
  // The TXT value may arrive as a Buffer from the wire.
  assert.deepEqual(parseRecord({ ...good, txt: { v: Buffer.from('2') } }), { name: good.name, port: 49799 })
  assert.throws(() => createRecord({ port: 49799, name: 'not random' }))
  assert.throws(() => createRecord({ port: 0 }))
})
