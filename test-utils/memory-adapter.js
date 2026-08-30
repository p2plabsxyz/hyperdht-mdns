'use strict'

class MemoryAdapter {
  constructor (bus) {
    this.bus = bus
    this.record = null
    this.records = new Map()
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

    for (const advertisement of this.bus) {
      setImmediate(() => {
        this.handlers?.onService(asService(advertisement.record))
        advertisement.adapter.handlers?.onService(asService(record))
      })
    }

    const advertisement = { adapter: this, record }
    this.records.set(record.name, record)
    this.bus.add(advertisement)
    let stopped = false

    return {
      stop: () => {
        if (stopped) return
        stopped = true
        if (this.records.get(record.name) === record) this.records.delete(record.name)
        this.bus.delete(advertisement)
        const peers = new Set([...this.bus].map(entry => entry.adapter))
        for (const peer of peers) {
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
