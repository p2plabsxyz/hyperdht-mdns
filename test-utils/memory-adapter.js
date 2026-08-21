'use strict'

class MemoryAdapter {
  constructor (bus) {
    this.bus = bus
    this.record = null
    this.handlers = null
  }

  browse (query, handlers) {
    this.query = query
    this.handlers = handlers
    let stopped = false

    return {
      stop: () => {
        if (stopped) return
        stopped = true
        this.handlers = null
      }
    }
  }

  advertise (record) {
    this.record = record

    for (const peer of this.bus) {
      setImmediate(() => {
        this.handlers?.onService(asService(peer.record))
        peer.handlers?.onService(asService(record))
      })
    }

    this.bus.add(this)
    let stopped = false

    return {
      stop: () => {
        if (stopped) return
        stopped = true
        if (this.record !== record) return

        this.bus.delete(this)
        for (const peer of this.bus) {
          setImmediate(() => peer.handlers?.onServiceDown(asService(record)))
        }
      }
    }
  }
}

function asService (record) {
  return {
    ...record,
    referer: { address: '127.0.0.1' },
    addresses: ['127.0.0.1']
  }
}

module.exports = MemoryAdapter
