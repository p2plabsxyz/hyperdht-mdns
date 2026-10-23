'use strict'

// One worker process: a batch of honest devices for test/stress/run.js. mDNS
// goes through the parent, which plays the multicast network.

const Protomux = require('protomux')
const c = require('compact-encoding')
const HyperDHTmDNS = require('../..')

const { index, ports, limits, announceInterval } = JSON.parse(process.argv[2])
const devices = new Map()
// The parent may be gone already while this one shuts down. With a callback
// a failed send is passed to it rather than thrown as an 'error' event.
const send = (message) => { if (process.connected) process.send(message, noop) }
function noop () {}

class BusAdapter {
  constructor (port) {
    this.port = port
    this.liveness = true
    this.handlers = null
    this.record = null
    this.timer = null
  }

  setPopulation () {}

  browse (query, handlers) {
    this.handlers = handlers
    send({ type: 'query', port: this.port })
    return {
      query: () => send({ type: 'query', port: this.port }),
      stop: () => { this.handlers = null }
    }
  }

  advertise (record) {
    this.record = record
    const announce = () => {
      send({ type: 'advertise', port: this.port, record: { name: record.name, port: record.port, txt: record.txt } })
      this.timer = setTimeout(announce, announceInterval * (0.75 + Math.random() * 0.5))
      this.timer.unref()
    }
    announce()
    return {
      stop: () => {
        clearTimeout(this.timer)
        send({ type: 'stop', port: this.port, name: record.name, goodbye: !this.vanished })
      }
    }
  }
}

function hostKey (address) {
  if (address.port >= 23000 && address.port < 24000) return 'hostile'
  return `device-${address.port}`
}

function startDevice (port) {
  const adapter = new BusAdapter(port)
  const lan = new HyperDHTmDNS({ host: '127.0.0.1', port, allowLoopback: true, adapter, hostKey, limits })
  lan.on('warning', () => {})
  lan.on('error', () => {})
  const device = { port, lan, adapter, rooms: new Set(), messages: new Map(), peers: new Set(), sessions: [] }
  lan.on('connection', (socket) => gossip(device, socket))
  devices.set(port, device)
  return device
}

// Room messages pass from peer to peer, only between peers that share the
// room, and a device that comes back asks for what it missed: the ids-first
// passing PeerChat does, in miniature.
function gossip (device, socket) {
  const peer = { rooms: new Set(), channel: null }
  const channel = Protomux.from(socket).createChannel({
    protocol: 'stress-gossip',
    onopen () {
      hello.send({ rooms: [...device.rooms], have: [...device.messages.keys()] })
    },
    onclose () { device.peers.delete(peer) }
  })
  if (!channel) return
  const hello = channel.addMessage({
    encoding: c.json,
    onmessage ({ rooms, have }) {
      for (const room of rooms || []) peer.rooms.add(room)
      const theirs = new Set(have || [])
      for (const [id, message] of device.messages) {
        if (!theirs.has(id) && peer.rooms.has(message.room)) msg.send(message)
      }
    }
  })
  const msg = channel.addMessage({
    encoding: c.json,
    onmessage (message) { receive(device, message, peer) }
  })
  peer.channel = channel
  peer.send = (message) => msg.send(message)
  device.peers.add(peer)
  channel.open()
}

function receive (device, message, from) {
  if (device.messages.has(message.id) || !device.rooms.has(message.room)) return
  device.messages.set(message.id, message)
  send({ type: 'received', port: device.port, id: message.id, at: Date.now() })
  for (const peer of device.peers) {
    if (peer !== from && peer.rooms.has(message.room)) {
      try { peer.send(message) } catch {}
    }
  }
}

process.on('message', async (command) => {
  try {
    if (command.cmd === 'start') {
      for (const port of ports) startDevice(port)
      await Promise.all([...devices.values()].map((device) => device.lan.ready()))
      send({ type: 'started', index })
    } else if (command.cmd === 'service') {
      for (const device of devices.values()) {
        if (device.away || device.adapter.record?.name === command.record.name) continue
        device.adapter.handlers?.onService({ ...command.record, referer: { address: '127.0.0.1', port: command.record.port } })
      }
    } else if (command.cmd === 'down') {
      for (const device of devices.values()) {
        if (device.away) continue
        device.adapter.handlers?.onServiceDown({ name: command.name, referer: { address: '127.0.0.1', port: command.port } })
      }
    } else if (command.cmd === 'join') {
      for (const [port, rooms] of Object.entries(command.rooms)) {
        const device = devices.get(Number(port))
        if (!device) continue
        for (const room of rooms) {
          device.rooms.add(room)
          device.sessions.push(device.lan.join(Buffer.from(room, 'hex')))
        }
      }
    } else if (command.cmd === 'originate') {
      const device = devices.get(command.port)
      receive(device, { id: command.id, room: command.room, at: Date.now() }, null)
    } else if (command.cmd === 'vanish' || command.cmd === 'away') {
      for (const port of command.ports) {
        const device = devices.get(port)
        if (!device) continue
        device.adapter.vanished = true
        await device.lan.destroy()
        devices.delete(port)
        if (command.cmd === 'away') devices.set(port, { away: true, rooms: device.rooms, messages: device.messages })
      }
      send({ type: 'done', cmd: command.cmd })
    } else if (command.cmd === 'back') {
      for (const port of command.ports) {
        const before = devices.get(port)
        if (!before?.away) continue
        devices.delete(port)
        const device = startDevice(port)
        device.messages = before.messages
        await device.lan.ready()
        for (const room of before.rooms) {
          device.rooms.add(room)
          device.sessions.push(device.lan.join(Buffer.from(room, 'hex')))
        }
      }
      send({ type: 'done', cmd: 'back' })
    } else if (command.cmd === 'stats') {
      const stats = []
      for (const device of devices.values()) {
        if (device.away) continue
        const info = device.lan.info()
        const hostileDevices = [...device.lan._devices.values()].filter((entry) => entry.hostKey === 'hostile').length
        stats.push({
          port: device.port,
          key: device.lan.keyPair.publicKey.toString('hex').slice(0, 16),
          devices: info.devices,
          deviceNames: command.names ? [...device.lan._devices.values()].map((entry) => entry.port) : undefined,
          hostileDevices,
          hostileNodes: device.lan.dht.hyperdhtMdns.nodesFrom({ host: '127.0.0.1', port: 23000 }),
          seeds: info.seeds,
          nodes: info.nodes,
          connections: info.connections,
          messages: device.messages.size,
          stats: info.stats
        })
      }
      send({ type: 'stats', stats, memory: process.memoryUsage().rss })
    } else if (command.cmd === 'stop') {
      await Promise.allSettled([...devices.values()].map((device) => device.lan?.destroy()))
      process.exit(0)
    }
  } catch (error) {
    send({ type: 'error', message: error.stack })
  }
})
