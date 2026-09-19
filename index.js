'use strict'

const HyperDHTmDNS = require('./src/hyperswarm-lan')

module.exports = HyperDHTmDNS
module.exports.HyperDHTmDNS = HyperDHTmDNS
// Lazy: touching this getter is what loads bonjour-service. Requiring it up
// front would drag Node's dgram/os into every consumer, including ones that
// pass their own `adapter` precisely because those builtins do not exist on
// their runtime.
Object.defineProperty(module.exports, 'BonjourAdapter', {
  enumerable: true,
  configurable: true,
  get () {
    return require('./src/bonjour-adapter')
  }
})
module.exports.SERVICE_TYPE = require('./src/record').SERVICE_TYPE
module.exports.topicToken = require('./src/record').topicToken
module.exports.createRecords = require('./src/record').createRecords
module.exports.attachHyperSDK = require('./src/hyper-sdk')
module.exports.selectLocalIPv4 = require('./src/network').selectLocalIPv4
