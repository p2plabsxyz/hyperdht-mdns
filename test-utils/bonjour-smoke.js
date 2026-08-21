'use strict'

const { randomBytes } = require('crypto')
const { once } = require('events')
const HyperDHTmDNS = require('..')

async function main () {
  const topic = randomBytes(32)
  const first = new HyperDHTmDNS({ port: 49991 })
  const second = new HyperDHTmDNS({ port: 49992 })

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
      timeout(15_000, 'Real bonjour-service discovery timed out')
    ])
    for (const [socket] of connections) socket.on('error', () => {})

    console.log(`mDNS discovery passed on ${first.host}`)
    console.log(`bootstrap nodes: ${first.dht.bootstrapNodes.length}, ${second.dht.bootstrapNodes.length}`)
  } finally {
    await Promise.allSettled([first.destroy(), second.destroy()])
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
