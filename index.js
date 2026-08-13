'use strict'

const HyperswarmLAN = require('./src/hyperswarm-lan')

module.exports = HyperswarmLAN
module.exports.HyperswarmLAN = HyperswarmLAN
module.exports.BonjourDiscovery = require('./src/bonjour-discovery')
module.exports.SERVICE_TYPE = require('./src/record').SERVICE_TYPE
module.exports.topicToken = require('./src/record').topicToken
module.exports.attachHyperSDK = require('./src/hyper-sdk')
