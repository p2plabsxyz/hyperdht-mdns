'use strict'

const { createHash } = require('crypto')
const HyperDHTmDNS = require('..')

async function main () {
  const nodeName = process.env.NODE_NAME || 'unknown'
  const expectedPeers = parseInt(process.env.EXPECTED_PEERS || '1', 10)
  const connectedPeers = new Set()

  const topic = createHash('sha256').update('hyperdht-mdns-offline-test').digest()
  const lan = process.env.PORT ? new HyperDHTmDNS({ port: parseInt(process.env.PORT, 10) }) : new HyperDHTmDNS()

  lan.on('error', error => console.error(`[${nodeName} error]`, error.message))
  lan.on('warning', error => console.warn(`[${nodeName} warning]`, error.message))

  lan.on('connection', (socket, info) => {
    const peerId = socket.remotePublicKey?.toString('hex')
    if (!peerId) return

    console.log(`[${nodeName}] connected to ${peerId.slice(0, 12)}`)
    connectedPeers.add(peerId)

    if (connectedPeers.size >= expectedPeers) {
      console.log(`[${nodeName}] Successfully connected to ${expectedPeers} peers!`)
      setTimeout(() => {
        process.exit(0)
      }, 2000)
    }
  })

  lan.join(topic)
  await lan.ready()

  console.log(`[${nodeName}] Started. Waiting for ${expectedPeers} peers...`)

  setTimeout(() => {
    console.error(`[${nodeName}] Timeout waiting for peers. Connected to ${connectedPeers.size}/${expectedPeers}`)
    process.exit(1)
  }, 30000)
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
