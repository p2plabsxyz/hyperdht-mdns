'use strict'

/**
 * Token buckets kept per key (an IP address, usually), in a table of bounded
 * size: a sender spraying from many addresses evicts the oldest buckets rather
 * than growing memory. `take()` answers whether one more event from that key
 * is allowed now.
 */
class RateLimiter {
  constructor ({ rate, burst, maxKeys = 4096, now = Date.now } = {}) {
    if (!(rate > 0)) throw new RangeError('rate must be positive (events per second)')
    this.rate = rate
    this.burst = burst > 0 ? burst : rate
    this.maxKeys = maxKeys
    this._now = now
    this._buckets = new Map()
  }

  take (key, cost = 1) {
    const now = this._now()
    let bucket = this._buckets.get(key)

    if (bucket) {
      // Re-inserted so the map's order is least recently used first.
      this._buckets.delete(key)
      bucket.tokens = Math.min(this.burst, bucket.tokens + (now - bucket.at) * this.rate / 1000)
      bucket.at = now
    } else {
      bucket = { tokens: this.burst, at: now }
      if (this._buckets.size >= this.maxKeys) {
        this._buckets.delete(this._buckets.keys().next().value)
      }
    }
    this._buckets.set(key, bucket)

    if (bucket.tokens < cost) return false
    bucket.tokens -= cost
    return true
  }

  clear () {
    this._buckets.clear()
  }
}

/** How many of something each key holds, for caps per IP address. */
class Counter {
  constructor () {
    this._counts = new Map()
  }

  get (key) {
    return this._counts.get(key) || 0
  }

  add (key) {
    this._counts.set(key, this.get(key) + 1)
  }

  remove (key) {
    const count = this.get(key) - 1
    if (count > 0) this._counts.set(key, count)
    else this._counts.delete(key)
  }

  clear () {
    this._counts.clear()
  }
}

module.exports = { Counter, RateLimiter }
