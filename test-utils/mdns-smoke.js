'use strict'

// Two LAN DHTs on this computer find each other over real multicast mDNS and
// connect. A third socket listens to the same multicast traffic and checks
// what the two put on the wire: a random name, the port, the address and the
// record version, and nothing that says who they are or what they joined.

const { randomBytes } = require('crypto')
const { once } = require('events')
const multicastDNS = require('multicast-dns')
const HyperDHTmDNS = require('..')
const { localAddresses } = require('../src/lan-dht')

async function main () {
  const topic = randomBytes(32)
  const listener = multicastDNS()
  const heard = []
  listener.on('response', (response) => heard.push(...response.answers, ...response.additionals))

  const first = new HyperDHTmDNS({ port: 21901 })
  const second = new HyperDHTmDNS({ port: 21902 })

  first.on('warning', error => console.warn(`[first] ${error.message}`))
  second.on('warning', error => console.warn(`[second] ${error.message}`))

  try {
    const firstConnection = once(first, 'connection')
    const secondConnection = once(second, 'connection')
    first.join(topic)
    second.join(topic)

    await Promise.all([first.ready(), second.ready()])
    const connections = await Promise.race([
      Promise.all([firstConnection, secondConnection]),
      timeout(15_000, 'Real mDNS discovery timed out')
    ])
    for (const [socket] of connections) socket.on('error', () => {})

    console.log(`mDNS discovery passed on ${first.host}`)
    console.log(`bootstrap nodes: ${first.dht.bootstrapNodes.length}, ${second.dht.bootstrapNodes.length}`)

    checkWire(heard, [first, second], topic)
    console.log('mDNS records carried only a random name, the port, the address and the version')

    // Whatever else is on this network, the LAN DHTs keep to it.
    const isLocal = localAddresses(first.host)
    for (const lan of [first, second]) {
      const outside = lan.dht.toArray().filter((node) => !isLocal(node.host))
      if (outside.length) throw new Error(`Nodes outside the local network: ${outside.map((node) => node.host).join(', ')}`)
    }
    console.log('routing tables hold local nodes only')
  } finally {
    await Promise.allSettled([first.destroy(), second.destroy()])
    listener.destroy()
  }
}

// Other mDNS traffic on the network is left out: only the records of these
// two instances are checked.
function checkWire (heard, instances, topic) {
  const names = instances.map((lan) => lan.name)
  const ours = heard.filter((record) => names.some((name) => String(record.name).includes(name)))
  if (ours.length === 0) throw new Error('The listener heard none of the two instances\' records')

  const secrets = [topic, ...instances.map((lan) => lan.keyPair.publicKey)]
    .flatMap((value) => [value.toString('hex'), value.toString('base64'), value.toString('base64url')])
  for (const record of ours) {
    const text = JSON.stringify(record, (key, value) => value?.type === 'Buffer' ? Buffer.from(value.data).toString() : value)
    for (const secret of secrets) {
      if (text.includes(secret)) throw new Error(`A key or topic went out over mDNS: ${text}`)
    }
    if (record.type === 'TXT') {
      const entries = [].concat(record.data).map((entry) => entry.toString())
      if (entries.join(',') !== 'v=2') throw new Error(`Unexpected TXT data: ${entries.join(',')}`)
    }
  }
}

function timeout (ms, message) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms)
    timer.unref()
  })
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
