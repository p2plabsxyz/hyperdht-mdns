'use strict'

const { EventEmitter } = require('events')
const { Bonjour } = require('bonjour-service')
const { SERVICE_PROTOCOL, SERVICE_TYPE } = require('./record')

class BonjourDiscovery extends EventEmitter {
  constructor (opts = {}) {
    super()
    this.type = opts.type || SERVICE_TYPE
    this.protocol = opts.protocol || SERVICE_PROTOCOL
    this.bonjour = opts.bonjour || new Bonjour(undefined, (error) => this.emit('error', error))
    this.browser = null
    this.service = null
  }

  async start (record, onPeer) {
    if (this.browser || this.service) throw new Error('mDNS discovery is already started')

    this.browser = this.bonjour.find({ type: this.type, protocol: this.protocol })
    this.browser.on('up', onPeer)
    this.browser.on('down', (service) => this.emit('down', service))

    this.service = this.bonjour.publish(record)
  }

  async update (record) {
    if (!this.browser || !this.service) throw new Error('mDNS discovery is not started')

    const service = this.service
    this.service = null
    await stopService(service)
    this.service = this.bonjour.publish(record)
  }

  async stop () {
    if (this.browser) {
      this.browser.stop()
      this.browser = null
    }

    if (this.service) {
      const service = this.service
      this.service = null
      await stopService(service)
    }
  }

  async destroy () {
    await this.stop()
    if (this.bonjour) this.bonjour.destroy()
  }
}

function stopService (service) {
  return new Promise((resolve) => service.stop(resolve))
}

module.exports = BonjourDiscovery
