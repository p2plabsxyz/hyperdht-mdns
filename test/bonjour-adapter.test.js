'use strict'

const { EventEmitter } = require('events')
const test = require('node:test')
const assert = require('node:assert/strict')
const BonjourAdapter = require('../src/bonjour-adapter')

class FakeBrowser extends EventEmitter {
  stop () { this.stopped = true }
}

class FakeService {
  stop (done) {
    this.stopped = true
    done()
  }
}

test('maps advertise and browse to one lazily-owned bonjour instance', async () => {
  const browser = new FakeBrowser()
  const service = new FakeService()
  const bonjour = {
    find (query) { this.query = query; return browser },
    publish (record) { this.record = record; return service },
    destroy () { this.destroyed = true }
  }
  let bonjourError
  let creates = 0
  const adapter = new BonjourAdapter({
    createBonjour (onError) {
      creates++
      bonjourError = onError
      return bonjour
    }
  })
  const found = []
  const lost = []
  const errors = []
  const query = { type: 'hyperswarm-lan', protocol: 'udp' }
  const record = { name: 'node-a', ...query, port: 49799, txt: { v: '1' } }

  const browseHandle = adapter.browse(query, {
    onService: service => found.push(service),
    onServiceDown: service => lost.push(service),
    onError: error => errors.push(error)
  })
  const advertiseHandle = adapter.advertise(record, {
    onError: error => errors.push(error)
  })

  browser.emit('up', { name: 'node-b' })
  browser.emit('down', { name: 'node-c' })
  bonjourError(new Error('socket failed'))

  assert.equal(creates, 1)
  assert.deepEqual(bonjour.query, query)
  assert.deepEqual(bonjour.record, record)
  assert.deepEqual(found, [{ name: 'node-b' }])
  assert.deepEqual(lost, [{ name: 'node-c' }])
  assert.equal(errors.length, 2)

  await advertiseHandle.stop()
  assert.equal(service.stopped, true)
  assert.equal(bonjour.destroyed, undefined)
  await browseHandle.stop()
  assert.equal(browser.stopped, true)
  assert.equal(bonjour.destroyed, true)
})
