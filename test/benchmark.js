'use strict'

const { createHash } = require('crypto')
const HyperDHTmDNS = require('..')

async function main () {
  const role = process.env.ROLE || 'server'
  const isServer = role === 'server'
  const isClient = !isServer

  const topic = createHash('sha256').update('hyperdht-mdns-benchmark').digest()
  const lan = process.env.PORT ? new HyperDHTmDNS({ port: parseInt(process.env.PORT, 10) }) : new HyperDHTmDNS()

  lan.on('error', error => console.error(`[mDNS error] ${error.message}`))
  lan.on('warning', error => console.warn(`[warning] ${error.message}`))

  let clientsConnected = 0
  const expectedClients = parseInt(process.env.EXPECTED_CLIENTS || '1', 10)

  lan.on('connection', async (socket, info) => {
    console.log(`[connected] to ${socket.remotePublicKey?.toString('hex').slice(0, 12) || 'unknown'}`)

    if (isServer) {
      clientsConnected++
      socket.pipe(socket)

      if (clientsConnected >= expectedClients) {
        setTimeout(() => {
          console.log('Server shutting down.')
          process.exit(0)
        }, 30000)
      }
    }

    if (role === 'throughput') {
      const startTime = Date.now()
      let bytesReceived = 0
      const totalBytes = 50 * 1024 * 1024
      const chunk = Buffer.alloc(1024 * 64, 'a')

      let written = 0
      function write () {
        while (written < totalBytes) {
          if (!socket.write(chunk)) {
            written += chunk.length
            socket.once('drain', write)
            return
          }
          written += chunk.length
        }
      }
      write()

      socket.on('data', data => {
        bytesReceived += data.length
        if (bytesReceived >= totalBytes) {
          const duration = (Date.now() - startTime) / 1000
          const mbps = (totalBytes / (1024 * 1024)) / duration
          console.log('\nThroughput Benchmark')
          console.log(`Transferred: ${totalBytes / (1024 * 1024)} MB`)
          console.log(`Time: ${duration.toFixed(2)} seconds`)
          console.log(`Throughput: ${mbps.toFixed(2)} MB/s\n`)
          process.exit(0)
        }
      })
    }

    if (role === 'latency') {
      const pings = 1000
      let count = 0
      const latencies = []
      let lastSend = 0

      socket.on('data', () => {
        const rtt = Date.now() - lastSend
        latencies.push(rtt)
        count++

        if (count < pings) {
          sendPing()
        } else {
          const avg = latencies.reduce((a, b) => a + b, 0) / latencies.length
          const min = Math.min(...latencies)
          const max = Math.max(...latencies)

          console.log('\nLatency Benchmark')
          console.log(`Pings: ${pings}`)
          console.log(`Average RTT: ${avg.toFixed(2)} ms`)
          console.log(`Min RTT: ${min} ms`)
          console.log(`Max RTT: ${max} ms\n`)
          process.exit(0)
        }
      })

      function sendPing () {
        lastSend = Date.now()
        socket.write(Buffer.from('ping'))
      }

      sendPing()
    }
  })

  lan.join(topic, { client: isClient, server: isServer })
  await lan.ready()

  console.log(`Running as ${role}... Waiting for connection.`)
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
