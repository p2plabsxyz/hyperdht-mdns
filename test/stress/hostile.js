'use strict'

// One hostile machine for test/stress/run.js: many LAN DHT nodes on one
// address, a flood of made-up mDNS devices, floods of requests (some with
// made-up tokens), and fake peers announced under a room's topic.

const { randomBytes } = require('crypto')
const HyperDHT = require('hyperdht')

// dht-rpc's FIND_NODE.
const FIND_NODE = 2

const { ports, targets, topic, fakeNames } = JSON.parse(process.argv[2])
const nodes = []
// The parent may be gone already while this one shuts down. With a callback
// a failed send is passed to it rather than thrown as an 'error' event.
const send = (message) => { if (process.connected) process.send(message, noop) }
function noop () {}
// Set from the message handler, which the loops below cannot see.
const state = { running: true, wrongTokens: { sent: 0, answered: 0, started: 0 } }

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
  // Requests with tokens the honest devices never handed out, all at one
  // device and faster than it lets one machine ask. dht-rpc answers these
  // by itself, so they must count against the rate limits before it reads
  // them.
  const flooded = { host: '127.0.0.1', port: targets[0] }
  const wrongTokens = async (dht) => {
    while (state.running) {
      await Promise.allSettled(Array.from({ length: 20 }, () => wrongToken(dht, flooded)))
    }
  }
  for (const dht of nodes.slice(0, 10)) flood(dht)
  for (const dht of nodes.slice(10, 20)) announce(dht)
  state.wrongTokens.started = Date.now()
  for (const dht of nodes.slice(20, 30)) wrongTokens(dht)
}

function wrongToken (dht, to) {
  const req = dht.io.createRequest(to, randomBytes(32), true, FIND_NODE, randomBytes(32), null, null, 0)
  if (!req) return Promise.resolve()
  state.wrongTokens.sent++
  return new Promise((resolve) => {
    req.retries = 0
    req.onresponse = () => {
      state.wrongTokens.answered++
      resolve()
    }
    req.onerror = resolve
    req.send()
  })
}

process.on('message', async (command) => {
  if (command.cmd === 'count') {
    const { sent, answered, started } = state.wrongTokens
    send({ type: 'count', sent, answered, seconds: started ? (Date.now() - started) / 1000 : 0 })
  }
  if (command.cmd === 'stop') {
    state.running = false
    await Promise.allSettled(nodes.map((dht) => dht.destroy()))
    process.exit(0)
  }
})

main().catch((error) => send({ type: 'error', message: error.stack }))
