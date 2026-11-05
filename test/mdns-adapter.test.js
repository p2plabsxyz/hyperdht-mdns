'use strict'

const { EventEmitter } = require('events')
const test = require('node:test')
const assert = require('node:assert/strict')
const MDNSAdapter = require('../src/mdns-adapter')
const { createRecord } = require('../src/record')

class FakeMDNS extends EventEmitter {
  constructor () {
    super()
    this.sent = []
    this.destroyed = false
  }

  respond (packet, cb) {
    this.sent.push({ kind: 'respond', packet })
    cb?.()
  }

  query (packet, cb) {
    this.sent.push({ kind: 'query', packet })
    cb?.()
  }

  destroy () { this.destroyed = true }

  responses () {
    return this.sent.filter((entry) => entry.kind === 'respond').map((entry) => entry.packet)
  }
}

function setup (opts = {}) {
  const mdns = new FakeMDNS()
  const adapter = new MDNSAdapter({ createMDNS: () => mdns, ...opts })
  return { mdns, adapter }
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const SERVICE = '_hyperdht-mdns._udp.local'

test('announces a made-up name, the port and the one LAN address, and nothing else', async () => {
  const { mdns, adapter } = setup()
  const record = { ...createRecord({ port: 49799 }), address: '192.168.1.20' }
  const handle = adapter.advertise(record)

  const [first] = mdns.responses()
  const fqdn = `${record.name}.${SERVICE}`
  assert.deepEqual(first.answers.map((answer) => [answer.type, answer.name]), [
    ['PTR', SERVICE],
    ['SRV', fqdn],
    ['TXT', fqdn],
    ['A', `${record.name}.local`]
  ])
  assert.equal(first.answers[0].data, fqdn)
  assert.deepEqual(first.answers[1].data, { port: 49799, target: `${record.name}.local` })
  assert.deepEqual(first.answers[2].data, ['v=2'])
  assert.equal(first.answers[3].data, '192.168.1.20')
  // No machine hostname anywhere in what goes out.
  const text = JSON.stringify(first)
  assert.equal(text.includes(require('os').hostname()), false)
  assert.ok(first.answers.every((answer) => answer.ttl === 300))

  await handle.stop()
  const goodbye = mdns.responses().at(-1)
  assert.ok(goodbye.answers.every((answer) => answer.ttl === 0))
  assert.equal(mdns.destroyed, true)
})

test('announces again on a jittered timer, so a device gone quiet is noticed', async () => {
  const { mdns, adapter } = setup({ announceInterval: 40 })
  const handle = adapter.advertise({ ...createRecord({ port: 49799 }), address: '10.0.0.2' })
  await wait(1400)
  // The start, the repeat a second later, then the timer.
  assert.ok(mdns.responses().length >= 4, `only ${mdns.responses().length} announcements`)
  await handle.stop()
})

test('reports every sighting for liveness, and a goodbye as down', () => {
  const { mdns, adapter } = setup()
  const seen = []
  const down = []
  adapter.browse({ type: 'hyperdht-mdns', protocol: 'udp' }, {
    onService: (service) => seen.push(service),
    onServiceDown: (service) => down.push(service)
  })
  assert.deepEqual(mdns.sent[0], { kind: 'query', packet: { questions: [{ name: SERVICE, type: 'PTR' }] } })

  const name = 'abcdefgh12345678'
  const fqdn = `${name}.${SERVICE}`
  const packet = (ttl) => ({
    answers: [{ name: SERVICE, type: 'PTR', ttl, data: fqdn }],
    additionals: [
      { name: fqdn, type: 'SRV', ttl, data: { port: 49801, target: `${name}.local` } },
      { name: fqdn, type: 'TXT', ttl, data: [Buffer.from('v=2')] },
      { name: `${name}.local`, type: 'A', ttl, data: '192.168.1.30' }
    ]
  })
  const rinfo = { address: '192.168.1.30', port: 5353 }
  mdns.emit('response', packet(300), rinfo)
  mdns.emit('response', packet(300), rinfo)
  assert.equal(seen.length, 2)
  assert.deepEqual({ ...seen[0], referer: undefined }, {
    name,
    fqdn,
    host: `${name}.local`,
    port: 49801,
    txt: { v: '2' },
    addresses: ['192.168.1.30'],
    referer: undefined,
    ttl: 300
  })
  assert.equal(seen[0].referer, rinfo)

  mdns.emit('response', packet(0), rinfo)
  assert.deepEqual(down, [{ name, fqdn, referer: rinfo }])

  // Other services on the network are not ours.
  mdns.emit('response', { answers: [{ name: '_airplay._tcp.local', type: 'PTR', ttl: 120, data: 'tv._airplay._tcp.local' }] }, rinfo)
  assert.equal(seen.length, 2)
})

test('answers a query once per asker every few seconds, after a short random delay', async () => {
  const { mdns, adapter } = setup()
  adapter.advertise({ ...createRecord({ port: 49799 }), address: '192.168.1.20' })
  mdns.sent.length = 0

  const ask = (address) => mdns.emit('query', { questions: [{ name: SERVICE, type: 'PTR' }] }, { address, port: 5353 })
  ask('192.168.1.40')
  ask('192.168.1.40')
  ask('192.168.1.40')
  assert.equal(mdns.responses().length, 0, 'not at once')
  await wait(200)
  assert.equal(mdns.responses().length, 1, 'the same asker gets one answer')

  ask('192.168.1.41')
  await wait(200)
  assert.equal(mdns.responses().length, 2)
})

test('answers stay within a cap for the whole device, however many askers there seem to be', async () => {
  const { mdns, adapter } = setup()
  adapter.advertise({ ...createRecord({ port: 49799 }), address: '192.168.1.20' })
  mdns.sent.length = 0
  // Each from another address, as anyone can make up.
  const ask = (i) => mdns.emit('query', { questions: [{ name: SERVICE, type: 'PTR' }] }, { address: `192.168.${i >> 8}.${i & 255}`, port: 5353 })

  // A hundred at once: the answer goes to the whole network, so one serves
  // them all.
  for (let i = 0; i < 100; i++) ask(i)
  await wait(200)
  assert.equal(mdns.responses().length, 1)

  // A hundred more over a second or two: a few answers, then one a second.
  const started = Date.now()
  for (let i = 100; i < 200; i++) {
    ask(i)
    await wait(15)
  }
  await wait(200)
  const seconds = (Date.now() - started) / 1000
  const answers = mdns.responses().length - 1
  assert.ok(answers >= 1 && answers <= 3 + Math.ceil(seconds), `${answers} answers in ${seconds} s`)
})

test('a query gets each record once, however many questions repeat it, and only its first questions are read', async () => {
  const { mdns, adapter } = setup()
  const record = createRecord({ port: 49799 })
  adapter.advertise({ ...record, address: '192.168.1.20' })
  mdns.sent.length = 0

  const repeated = Array.from({ length: 200 }, () => ({ name: SERVICE, type: 'PTR' }))
  mdns.emit('query', { questions: repeated }, { address: '192.168.1.40', port: 5353 })
  await wait(200)
  const [answer] = mdns.responses()
  assert.deepEqual(answer.answers.map((entry) => entry.type), ['PTR', 'SRV', 'TXT', 'A'])

  // A question for this device after eight others is not looked at.
  mdns.sent.length = 0
  const others = Array.from({ length: 8 }, (_, i) => ({ name: `other${i}._airplay._tcp.local`, type: 'PTR' }))
  mdns.emit('query', { questions: [...others, { name: `${record.name}.local`, type: 'A' }] }, { address: '192.168.1.41', port: 5353 })
  await wait(200)
  assert.equal(mdns.responses().length, 0)
})

test('an answer on its way is not sent for a device that said goodbye meanwhile', async () => {
  const { mdns, adapter } = setup()
  // Something else still uses the adapter, so it keeps running.
  adapter.browse({ type: 'hyperdht-mdns', protocol: 'udp' }, {})
  const handle = adapter.advertise({ ...createRecord({ port: 49799 }), address: '192.168.1.20' })
  mdns.sent.length = 0

  mdns.emit('query', { questions: [{ name: SERVICE, type: 'PTR' }] }, { address: '192.168.1.40', port: 5353 })
  await handle.stop()
  await wait(200)
  // The goodbye only, not the answer after it, which would bring it back.
  const responses = mdns.responses()
  assert.equal(responses.length, 1)
  assert.ok(responses[0].answers.every((answer) => answer.ttl === 0))
})

test('does not answer someone who already has this device', async () => {
  const { mdns, adapter } = setup()
  const record = createRecord({ port: 49799 })
  adapter.advertise({ ...record, address: '192.168.1.20' })
  mdns.sent.length = 0

  mdns.emit('query', {
    questions: [{ name: SERVICE, type: 'PTR' }],
    answers: [{ name: SERVICE, type: 'PTR', ttl: 280, data: `${record.name}.${SERVICE}` }]
  }, { address: '192.168.1.40', port: 5353 })
  await wait(200)
  assert.equal(mdns.responses().length, 0)
})

test('on a big network only a share of the devices answers a query', async () => {
  let roll = 0.5
  const { mdns, adapter } = setup({ random: () => roll })
  adapter.advertise({ ...createRecord({ port: 49799 }), address: '192.168.1.20' })
  adapter.setPopulation(1000)
  mdns.sent.length = 0

  mdns.emit('query', { questions: [{ name: SERVICE, type: 'PTR' }] }, { address: '192.168.1.40' })
  await wait(200)
  assert.equal(mdns.responses().length, 0, 'about 32 of 1000 answer, and this one rolled high')

  roll = 0.01
  mdns.emit('query', { questions: [{ name: SERVICE, type: 'PTR' }] }, { address: '192.168.1.41' })
  await wait(200)
  assert.equal(mdns.responses().length, 1)
})

test('answers a lookup of its own name with that record only', async () => {
  const { mdns, adapter } = setup()
  const record = createRecord({ port: 49799 })
  adapter.advertise({ ...record, address: '192.168.1.20' })
  mdns.sent.length = 0

  mdns.emit('query', { questions: [{ name: `${record.name}.local`, type: 'A' }] }, { address: '192.168.1.40' })
  await wait(200)
  const [answer] = mdns.responses()
  assert.deepEqual(answer.answers.map((entry) => entry.type), ['A'])
})

test('passes on only a few warnings about packets that do not decode', () => {
  const { mdns, adapter } = setup()
  const warnings = []
  adapter.browse({ type: 'hyperdht-mdns', protocol: 'udp' }, { onError: (error) => warnings.push(error) })

  // A device on the network sending junk as fast as it can.
  for (let i = 0; i < 1000; i++) mdns.emit('warning', new Error(`Cannot decode name (buffer overflow) ${i}`))
  assert.equal(warnings.length, 3)

  // Socket errors still come through.
  mdns.emit('error', new Error('EACCES'))
  assert.equal(warnings.length, 4)
})
