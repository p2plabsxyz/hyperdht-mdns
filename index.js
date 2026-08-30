'use strict'

const HyperDHTmDNS = require('./src/hyperswarm-lan')

module.exports = HyperDHTmDNS
module.exports.HyperDHTmDNS = HyperDHTmDNS
module.exports.BonjourAdapter = require('./src/bonjour-adapter')
module.exports.SERVICE_TYPE = require('./src/record').SERVICE_TYPE
module.exports.topicToken = require('./src/record').topicToken
module.exports.createRecords = require('./src/record').createRecords
module.exports.attachHyperSDK = require('./src/hyper-sdk')
module.exports.selectLocalIPv4 = require('./src/network').selectLocalIPv4
