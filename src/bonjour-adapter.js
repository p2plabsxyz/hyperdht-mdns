'use strict'

const { Bonjour } = require('bonjour-service')

class BonjourAdapter {
  constructor (opts = {}) {
    this._bonjour = opts.bonjour || null
    this._ownsBonjour = !opts.bonjour
    this._createBonjour = opts.createBonjour || ((onError) => new Bonjour(undefined, onError))
    this._activeHandles = 0
    this._errorHandlers = new Map()
  }

  advertise (record, handlers = {}) {
    const bonjour = this._acquire(handlers.onError)
    let service

    try {
      service = bonjour.publish(record)
    } catch (error) {
      this._release(handlers.onError)
      throw error
    }

    let stopped = false
    return {
      stop: async () => {
        if (stopped) return
        stopped = true

        try {
          await stopService(service)
        } finally {
          this._release(handlers.onError)
        }
      }
    }
  }

  browse (query, handlers = {}) {
    const bonjour = this._acquire(handlers.onError)
    let browser

    try {
      browser = bonjour.find(query)
    } catch (error) {
      this._release(handlers.onError)
      throw error
    }

    const onService = handlers.onService || noop
    const onServiceDown = handlers.onServiceDown || noop
    browser.on('up', onService)
    browser.on('down', onServiceDown)

    let stopped = false
    return {
      stop: async () => {
        if (stopped) return
        stopped = true

        browser.removeListener('up', onService)
        browser.removeListener('down', onServiceDown)
        browser.stop()
        this._release(handlers.onError)
      }
    }
  }

  _acquire (onError) {
    if (typeof onError === 'function') {
      this._errorHandlers.set(onError, (this._errorHandlers.get(onError) || 0) + 1)
    }
    this._activeHandles++

    if (!this._bonjour) {
      this._bonjour = this._createBonjour((error) => {
        for (const handler of this._errorHandlers.keys()) handler(error)
      })
    }

    return this._bonjour
  }

  _release (onError) {
    if (typeof onError === 'function') {
      const references = this._errorHandlers.get(onError) || 0
      if (references <= 1) this._errorHandlers.delete(onError)
      else this._errorHandlers.set(onError, references - 1)
    }
    if (this._activeHandles > 0) this._activeHandles--

    if (this._activeHandles === 0 && this._ownsBonjour && this._bonjour) {
      this._bonjour.destroy()
      this._bonjour = null
    }
  }
}

function stopService (service) {
  return new Promise((resolve) => service.stop(resolve))
}

function noop () {}

module.exports = BonjourAdapter
