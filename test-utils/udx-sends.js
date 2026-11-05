'use strict'

const path = require('path')

// udx-native as dht-rpc loads it, wherever npm put it.
const dir = (name, from) => path.dirname(require.resolve(`${name}/package.json`, { paths: [from] }))
const UDX = require(dir('udx-native', dir('dht-rpc', dir('hyperdht', __dirname))))

/**
 * Records every datagram handed to udx itself, beneath any check a DHT puts
 * on its sockets: what a node really sends. Only sockets made after this is
 * called are seen, so call it before making the node.
 */
function recordSends () {
  const sent = []
  const createSocket = UDX.prototype.createSocket
  UDX.prototype.createSocket = function (...args) {
    const socket = createSocket.apply(this, args)
    const udx = this
    for (const method of ['send', 'trySend']) {
      const original = socket[method]
      socket[method] = function (buffer, port, host, ttl) {
        sent.push({ udx, host, port })
        return original.call(this, buffer, port, host, ttl)
      }
    }
    return socket
  }
  return {
    sent,
    // Sends from one node to anywhere but loopback.
    outward: (dht) => sent.filter((entry) => entry.udx === dht.udx && entry.host !== '127.0.0.1'),
    restore () {
      UDX.prototype.createSocket = createSocket
    }
  }
}

module.exports = recordSends
