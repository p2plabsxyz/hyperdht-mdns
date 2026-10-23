'use strict'

// One hostile machine for test/stress/run.js: many LAN DHT nodes on one
// address, a flood of made-up mDNS devices, a flood of requests, and fake
// peers announced under a room's topic.

const { randomBytes } = require('crypto')
const HyperDHT = require('hyperdht')

const { ports, targets, topic, fakeNames } = JSON.parse(process.argv[2])
const nodes = []
// The parent may be gone already while this one shuts down. With a callback
// a failed send is passed to it rather than thrown as an 'error' event.
const send = (message) => { if (process.connected) process.send(message, noop) }
function noop () {}
// Set from the message handler, which the loops below cannot see.
const state = { running: true }

async function main () {
  for (const port of ports) {
    const dht = HyperDHT.bootstrapper(port, '127.0.0.1', { bootstrap: [] })
    nodes.push(dht)
    await dht.fullyBootstrapped()
  }
  send({ type: 'started' })

  // Made-up devices, all from this machine.
  for (let i = 0; i < fakeNames; i++) {
    const port = ports[i % ports.length]
    send({ type: 'advertise', port, record: { name: randomBytes(8).toString('hex'), port, txt: { v: '2' } } })
    if (i % 50 === 0) await new Promise((resolve) => setImmediate(resolve))
  }

  // Requests at honest devices, as fast as a loop allows.
  const flood = async (dht) => {
    while (state.running) {
      const target = targets[Math.floor(Math.random() * targets.length)]
      await Promise.allSettled(Array.from({ length: 20 }, () => dht.ping({ host: '127.0.0.1', port: target }, { retry: false })))
    }
  }
  // Fake peers under the room's topic.
  const announce = async (dht) => {
    for (const target of targets.slice(0, 40)) dht.addNode({ host: '127.0.0.1', port: target })
    while (state.running) {
      await dht.announce(Buffer.from(topic, 'hex'), HyperDHT.keyPair(), []).finished().catch(() => {})
    }
  }
  for (const dht of nodes.slice(0, 10)) flood(dht)
  for (const dht of nodes.slice(10, 20)) announce(dht)
}

process.on('message', async (command) => {
  if (command.cmd === 'stop') {
    state.running = false
    await Promise.allSettled(nodes.map((dht) => dht.destroy()))
    process.exit(0)
  }
})

main().catch((error) => send({ type: 'error', message: error.stack }))
