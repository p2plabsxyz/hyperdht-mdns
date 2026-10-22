'use strict'

/**
 * mDNS in memory: every adapter on the same bus hears every advertisement,
 * as on one multicast network. `address` is the sender's address as other
 * devices see it (127.0.0.1 unless a test simulates other machines).
 */
class MemoryAdapter {
  constructor (bus, { address = '127.0.0.1' } = {}) {
    this.bus = bus
    this.address = address
    this.liveness = true
    this.record = null
    this.records = new Map()
    this.handlers = null
    this.queries = 0
  }

  browse (query, handlers) {
    this.query = query
    this.handlers = handlers
    let stopped = false
    this.queries++
    this._replay()

    return {
      query: () => {
        this.queries++
        this._replay()
      },
      stop: () => {
        if (stopped) return
        stopped = true
        this.handlers = null
      }
    }
  }

  // Everyone answers a query with what they advertise.
  _replay () {
    for (const advertisement of this.bus) {
      if (advertisement.adapter === this) continue
      setImmediate(() => this.handlers?.onService(asService(advertisement)))
    }
  }

  advertise (record) {
    this.record = record
    const advertisement = { adapter: this, record }

    for (const other of this.bus) {
      if (other.adapter === this) continue
      setImmediate(() => {
        other.adapter.handlers?.onService(asService(advertisement))
      })
    }

    this.records.set(record.name, record)
    this.bus.add(advertisement)
    let stopped = false

    return {
      stop: () => {
        if (stopped) return
        stopped = true
        if (this.records.get(record.name) === record) this.records.delete(record.name)
        this.bus.delete(advertisement)
        if (this.vanished) return
        const peers = new Set([...this.bus].map(entry => entry.adapter))
        for (const peer of peers) {
          if (peer === this) continue
          setImmediate(() => peer.handlers?.onServiceDown({ name: record.name, referer: { address: this.address, port: record.port } }))
        }
      }
    }
  }

  // Leaves without a goodbye, as a device whose Wi-Fi went off.
  vanish () {
    this.vanished = true
    for (const advertisement of [...this.bus]) {
      if (advertisement.adapter === this) this.bus.delete(advertisement)
    }
    this.handlers = null
  }
}

function asService ({ adapter, record }) {
  return {
    ...record,
    referer: { address: adapter.address, port: record.port },
    addresses: [adapter.address]
  }
}

module.exports = MemoryAdapter
