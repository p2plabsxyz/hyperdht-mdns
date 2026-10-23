'use strict'

const HyperDHTmDNS = require('./src/hyperswarm-lan')
const record = require('./src/record')

module.exports = HyperDHTmDNS
module.exports.HyperDHTmDNS = HyperDHTmDNS
// Lazy: touching this getter is what loads multicast-dns. Requiring it up
// front would drag Node's dgram/os into every consumer, including ones that
// pass their own `adapter` precisely because those builtins do not exist on
// their runtime.
Object.defineProperty(module.exports, 'MDNSAdapter', {
  enumerable: true,
  configurable: true,
  get () {
    return require('./src/mdns-adapter')
  }
})
// The name the default adapter had before it was written on multicast-dns.
Object.defineProperty(module.exports, 'BonjourAdapter', {
  enumerable: false,
  configurable: true,
  get () {
    return require('./src/mdns-adapter')
  }
})
module.exports.SERVICE_TYPE = record.SERVICE_TYPE
module.exports.createRecord = record.createRecord
module.exports.parseRecord = record.parseRecord
module.exports.DEFAULT_LIMITS = HyperDHTmDNS.DEFAULT_LIMITS
module.exports.attachHyperSDK = require('./src/hyper-sdk')
module.exports.selectLocalIPv4 = require('./src/network').selectLocalIPv4
module.exports.createIdentityProof = require('./src/identity').createIdentityProof
module.exports.verifyIdentityProof = require('./src/identity').verifyIdentityProof
module.exports.identityGate = require('./src/identity-gate').identityGate
