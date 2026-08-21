'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { normalizeIPv4, selectLocalIPv4, serviceIPv4 } = require('../src/network')

test('selects a private non-loopback IPv4 address', () => {
  const interfaces = {
    loopback: [{ family: 'IPv4', internal: true, address: '127.0.0.1' }],
    ethernet: [{ family: 'IPv4', internal: false, address: '10.0.0.8' }],
    wifi: [{ family: 'IPv4', internal: false, address: '192.168.1.20' }]
  }

  assert.equal(selectLocalIPv4(interfaces), '192.168.1.20')
})

test('uses the multicast packet source before advertised addresses', () => {
  const service = {
    referer: { address: '::ffff:192.168.1.44' },
    addresses: ['10.0.0.44']
  }

  assert.equal(serviceIPv4(service), '192.168.1.44')
  assert.equal(normalizeIPv4('::ffff:10.0.0.1'), '10.0.0.1')
})
