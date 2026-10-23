'use strict'

const { RateLimiter } = require('./limits')

const TLD = '.local'
const ANNOUNCE_INTERVAL = 120_000
const ANNOUNCE_JITTER = 0.25
const RECORD_TTL = 300
const TARGET_ANSWERS = 32
const ANSWER_DELAY_MIN = 20
const ANSWER_DELAY_MAX = 120

/**
 * mDNS over multicast-dns, written for this module rather than a general
 * service browser:
 *
 * - a device's records carry its random instance name, the LAN DHT port and
 *   the one LAN address the DHT is bound to. No machine hostname (a Mac is
 *   usually named after its owner), no other interfaces such as a VPN or
 *   Docker network, no IPv6;
 * - the device announces itself again every couple of minutes on a jittered
 *   timer, so a device that is gone without a goodbye is noticed by the
 *   records not coming back, and every sighting is reported to the module
 *   (`liveness`);
 * - queries are answered at most once per asker every few seconds, and on a
 *   big network only by a share of the devices, so one query does not set
 *   off thousands of answers. A device asking again and again gets nothing
 *   more.
 */
class MDNSAdapter {
  /**
   * @param {object} [opts] - multicast-dns options (interface, bind, socket,
   *   ...), plus createMDNS to build the multicast-dns instance yourself, as
   *   on Bare where the socket needs shims.
   */
  constructor (opts = {}) {
    const { createMDNS, announceInterval, ttl, targetAnswers, random, ...mdnsOptions } = opts || {}
    this.liveness = true
    this._options = mdnsOptions
    this._createMDNS = createMDNS || ((options) => require('multicast-dns')(options))
    this._announceInterval = announceInterval || ANNOUNCE_INTERVAL
    this._ttl = ttl || RECORD_TTL
    this._targetAnswers = targetAnswers || TARGET_ANSWERS
    this._random = random || Math.random
    this._answersPerAsker = new RateLimiter({ rate: 1 / 5, burst: 1 })
    // multicast-dns warns about every packet that does not decode, and anyone
    // on the network can send those: passed on a few at a time, so a device
    // spraying them cannot flood an app's logs.
    this._warnings = new RateLimiter({ rate: 1 / 20, burst: 3 })
    this._population = 1
    this._mdns = null
    this._refs = 0
    this._errorHandlers = new Set()
    this._advertised = new Map()
    this._browsers = new Set()
    this._onQuery = (query, rinfo) => this._handleQuery(query, rinfo)
    this._onResponse = (response, rinfo) => this._handleResponse(response, rinfo)
    this._onError = (error) => {
      for (const handler of this._errorHandlers) handler(error)
    }
    this._onWarning = (error) => {
      if (this._warnings.take('all')) this._onError(error)
    }
  }

  /** How many devices the module knows of, which sets the share that answers. */
  setPopulation (count) {
    this._population = Math.max(1, Number(count) || 1)
  }

  advertise (record, handlers = {}) {
    const mdns = this._acquire(handlers.onError)
    const entry = {
      record,
      fqdn: instanceName(record),
      service: serviceName(record),
      host: hostName(record),
      address: record.address || record.host || null,
      timer: null,
      stopped: false
    }
    this._advertised.set(entry.fqdn, entry)

    const announce = () => {
      if (entry.stopped) return
      this._send(mdns, { answers: this._records(entry, this._ttl) })
      const jitter = 1 + (this._random() * 2 - 1) * ANNOUNCE_JITTER
      entry.timer = setTimeout(announce, Math.round(this._announceInterval * jitter))
      entry.timer.unref?.()
    }
    // Sent twice at the start, as mDNS asks, in case the first is lost.
    this._send(mdns, { answers: this._records(entry, this._ttl) })
    entry.timer = setTimeout(announce, 1000)
    entry.timer.unref?.()

    return {
      stop: async () => {
        if (entry.stopped) return
        entry.stopped = true
        clearTimeout(entry.timer)
        if (this._advertised.get(entry.fqdn) === entry) this._advertised.delete(entry.fqdn)
        // A goodbye: the same records with no time to live.
        await this._send(mdns, { answers: this._records(entry, 0) })
        this._release(handlers.onError)
      }
    }
  }

  browse (query, handlers = {}) {
    const mdns = this._acquire(handlers.onError)
    const browser = {
      service: `_${query.type}._${query.protocol || 'udp'}${TLD}`,
      onService: handlers.onService || noop,
      onServiceDown: handlers.onServiceDown || noop,
      stopped: false
    }
    this._browsers.add(browser)
    const ask = () => this._send(mdns, { questions: [{ name: browser.service, type: 'PTR' }] }, 'query')
    ask()

    return {
      // Asks the network again, for when the module has lost every neighbour.
      query: () => { if (!browser.stopped) ask() },
      stop: async () => {
        if (browser.stopped) return
        browser.stopped = true
        this._browsers.delete(browser)
        this._release(handlers.onError)
      }
    }
  }

  _records (entry, ttl) {
    const records = [
      { name: entry.service, type: 'PTR', ttl, data: entry.fqdn },
      { name: entry.fqdn, type: 'SRV', ttl, data: { port: entry.record.port, target: entry.host } },
      { name: entry.fqdn, type: 'TXT', ttl, data: txtData(entry.record.txt) }
    ]
    if (entry.address) records.push({ name: entry.host, type: 'A', ttl, data: entry.address })
    return records
  }

  _handleQuery (query, rinfo) {
    const answers = []
    for (const question of query.questions || []) {
      const name = String(question.name || '').toLowerCase()
      for (const entry of this._advertised.values()) {
        if (entry.stopped) continue
        const records = this._records(entry, this._ttl)
        if (name === entry.service && (question.type === 'PTR' || question.type === 'ANY')) {
          // Known-answer suppression: the asker already has this device.
          if (knows(query, entry, this._ttl)) continue
          answers.push(...records)
        } else if (name === entry.fqdn || name === entry.host) {
          answers.push(...records.filter((record) => record.name === name && matches(question.type, record.type)))
        }
      }
    }
    if (answers.length === 0) return

    const asker = rinfo?.address || ''
    if (!this._answersPerAsker.take(asker)) return
    // On a big network a share of the devices answers, about _targetAnswers
    // of them, which is plenty to start from.
    if (this._random() > Math.min(1, this._targetAnswers / this._population)) return

    const delay = ANSWER_DELAY_MIN + this._random() * (ANSWER_DELAY_MAX - ANSWER_DELAY_MIN)
    const mdns = this._mdns
    const timer = setTimeout(() => { if (mdns && this._mdns === mdns) this._send(mdns, { answers }) }, delay)
    timer.unref?.()
  }

  _handleResponse (response, rinfo) {
    if (this._browsers.size === 0) return
    const records = [...(response.answers || []), ...(response.additionals || [])]

    for (const browser of this._browsers) {
      for (const ptr of records) {
        if (ptr.type !== 'PTR' || String(ptr.name).toLowerCase() !== browser.service) continue
        const fqdn = String(ptr.data || '').toLowerCase()
        const name = fqdn.endsWith('.' + browser.service) ? fqdn.slice(0, -(browser.service.length + 1)) : ''
        if (!name) continue

        if (ptr.ttl === 0) {
          browser.onServiceDown({ name, fqdn, referer: rinfo })
          continue
        }

        const srv = records.find((record) => record.type === 'SRV' && String(record.name).toLowerCase() === fqdn)
        const txt = records.find((record) => record.type === 'TXT' && String(record.name).toLowerCase() === fqdn)
        if (!srv || !txt) continue
        const target = String(srv.data?.target || '').toLowerCase()
        const addresses = records
          .filter((record) => record.type === 'A' && String(record.name).toLowerCase() === target)
          .map((record) => record.data)

        browser.onService({
          name,
          fqdn,
          host: target,
          port: srv.data?.port,
          txt: decodeTxt(txt.data),
          addresses,
          referer: rinfo,
          ttl: ptr.ttl
        })
      }
    }
  }

  _send (mdns, packet, kind = 'respond') {
    return new Promise((resolve) => {
      try {
        mdns[kind](packet, (error) => {
          if (error) this._onError(error)
          resolve()
        })
      } catch (error) {
        this._onError(error)
        resolve()
      }
    })
  }

  _acquire (onError) {
    if (typeof onError === 'function') this._errorHandlers.add(onError)
    this._refs++
    if (!this._mdns) {
      this._mdns = this._createMDNS(this._options)
      this._mdns.on('query', this._onQuery)
      this._mdns.on('response', this._onResponse)
      this._mdns.on('error', this._onError)
      this._mdns.on('warning', this._onWarning)
    }
    return this._mdns
  }

  _release (onError) {
    if (typeof onError === 'function') this._errorHandlers.delete(onError)
    if (this._refs > 0) this._refs--
    if (this._refs === 0 && this._mdns) {
      const mdns = this._mdns
      this._mdns = null
      mdns.removeListener('query', this._onQuery)
      mdns.removeListener('response', this._onResponse)
      try { mdns.destroy() } catch {}
      this._answersPerAsker.clear()
    }
  }
}

function serviceName (record) {
  return `_${record.type}._${record.protocol || 'udp'}${TLD}`
}

function instanceName (record) {
  return `${record.name}.${serviceName(record)}`.toLowerCase()
}

function hostName (record) {
  return `${record.name}${TLD}`.toLowerCase()
}

function knows (query, entry, ttl) {
  return (query.answers || []).some((answer) => answer.type === 'PTR' &&
    String(answer.data || '').toLowerCase() === entry.fqdn &&
    answer.ttl >= ttl / 2)
}

function matches (asked, type) {
  return asked === 'ANY' || asked === type
}

function txtData (txt) {
  return Object.entries(txt || {}).map(([key, value]) => `${key}=${value}`)
}

function decodeTxt (data) {
  const txt = {}
  const entries = Array.isArray(data) ? data : [data]
  for (const entry of entries) {
    if (entry === null || entry === undefined) continue
    const text = Buffer.isBuffer(entry) ? entry.toString() : String(entry)
    const index = text.indexOf('=')
    if (index > 0) txt[text.slice(0, index)] = text.slice(index + 1)
  }
  return txt
}

function noop () {}

module.exports = MDNSAdapter
