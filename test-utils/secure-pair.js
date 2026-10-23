'use strict'

const net = require('net')
const SecretStream = require('@hyperswarm/secret-stream')
const HyperDHT = require('hyperdht')

/**
 * Two ends of one Noise-encrypted connection over TCP on loopback, made with
 * the given key pairs (random ones by default), as a LAN connection is.
 */
async function securePair ({ clientKeyPair = HyperDHT.keyPair(), serverKeyPair = HyperDHT.keyPair() } = {}) {
  let resolveServer
  const serverReady = new Promise((resolve) => { resolveServer = resolve })
  const server = net.createServer((socket) => {
    const stream = new SecretStream(false, socket, { keyPair: serverKeyPair })
    stream.on('error', () => {})
    stream.once('connect', () => resolveServer(stream))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))

  const socket = net.connect(server.address().port, '127.0.0.1')
  const client = new SecretStream(true, socket, { keyPair: clientKeyPair })
  client.on('error', () => {})
  await new Promise((resolve) => client.once('connect', resolve))
  const serverStream = await serverReady

  return {
    client,
    server: serverStream,
    async close () {
      client.destroy()
      serverStream.destroy()
      await new Promise((resolve) => server.close(resolve))
    }
  }
}

module.exports = securePair
