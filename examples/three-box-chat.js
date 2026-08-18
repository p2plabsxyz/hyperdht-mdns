#!/usr/bin/env node
'use strict'

const { createHash } = require('crypto')
const readline = require('readline')
const c = require('compact-encoding')
const Protomux = require('protomux')
const HyperDHTmDNS = require('..')

const CHAT_PROTOCOL = 'hyperdht-mdns/three-box-chat/1'

async function main () {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) return printHelp()

  const room = options.room || 'hyperdht-mdns-test'
  const name = options.name || process.env.COMPUTERNAME || process.env.HOSTNAME || 'anonymous'
  const topic = createHash('sha256').update(`hyperdht-mdns-chat:${room}`).digest()
  const lan = new HyperDHTmDNS({
    ...(options.host ? { host: options.host } : {}),
    ...(options.port ? { port: options.port } : {})
  })
  const peers = new Map()
  let closing = false

  lan.on('error', error => console.error(`[mDNS error] ${error.message}`))
  lan.on('warning', error => console.warn(`[warning] ${error.message}`))
  lan.on('peer', peer => {
    console.log(`[discovered] ${shortKey(peer.publicKey)} at ${peer.host}:${peer.port}; shared topics=${peer.topics.length}`)
  })
  lan.on('peer-reachable', peer => {
    console.log(`[reachable] ${shortKey(peer.publicKey)} via LAN-only HyperDHT`)
  })
  lan.on('peer-down', service => {
    console.log(`[mDNS down] ${service?.name || 'unknown peer'}`)
  })
  lan.on('connection', (socket, info) => attachChat(socket, info, peers, name))

  lan.join(topic, { client: true, server: true })
  await lan.ready()

  console.log('')
  console.log(`name: ${name}`)
  console.log(`room: ${room}`)
  console.log(`public key: ${lan.keyPair.publicKey.toString('hex')}`)
  console.log(`LAN DHT: ${lan.host}:${lan.port}/udp`)
  console.log(`bootstrap nodes: ${lan.dht.bootstrapNodes.length} (must be 0)`)
  console.log('Type a message and press Enter. Use Ctrl+C to stop.')
  console.log('')

  const terminal = readline.createInterface({ input: process.stdin, output: process.stdout })
  terminal.on('line', text => {
    const message = text.trim()
    if (!message) return

    const payload = JSON.stringify({ type: 'message', name, text: message, time: Date.now() })
    let sent = 0
    for (const peer of peers.values()) {
      if (peer.send(payload)) sent++
    }
    console.log(`[you -> ${sent} peer${sent === 1 ? '' : 's'}] ${message}`)
  })

  const close = async () => {
    if (closing) return
    closing = true
    terminal.close()
    await lan.destroy()
  }
  process.once('SIGINT', () => close().catch(error => console.error(error)))
  process.once('SIGTERM', () => close().catch(error => console.error(error)))
}

function attachChat (socket, info, peers, localName) {
  const publicKey = socket.remotePublicKey || info.publicKey
  if (!publicKey) return socket.destroy()

  const id = publicKey.toString('hex')
  const mux = Protomux.from(socket)
  const channel = mux.createChannel({ protocol: CHAT_PROTOCOL })
  if (!channel) return

  const message = channel.addMessage({
    encoding: c.string,
    onmessage (payload) {
      try {
        const frame = JSON.parse(payload)
        if (frame.type === 'hello') {
          peers.get(id).name = frame.name
          console.log(`[hello] ${frame.name} (${shortKey(publicKey)})`)
        } else if (frame.type === 'message') {
          console.log(`[${frame.name || shortKey(publicKey)}] ${frame.text}`)
        }
      } catch (error) {
        console.warn(`[warning] invalid frame from ${shortKey(publicKey)}: ${error.message}`)
      }
    }
  })

  const peer = {
    name: shortKey(publicKey),
    send: payload => !channel.closed && !socket.destroyed && message.send(payload)
  }
  peers.set(id, peer)

  channel.open()
  peer.send(JSON.stringify({ type: 'hello', name: localName }))
  console.log(`[connected] ${shortKey(publicKey)}; total peers=${peers.size}`)

  socket.once('close', () => {
    if (peers.get(id) === peer) peers.delete(id)
    console.log(`[disconnected] ${peer.name}; total peers=${peers.size}`)
  })
  socket.on('error', error => {
    console.warn(`[connection warning] ${shortKey(publicKey)}: ${error.message}`)
  })
}

function parseArgs (args) {
  const options = {}
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--help' || arg === '-h') options.help = true
    else if (arg === '--name') options.name = requiredValue(args, ++i, arg)
    else if (arg === '--room') options.room = requiredValue(args, ++i, arg)
    else if (arg === '--host') options.host = requiredValue(args, ++i, arg)
    else if (arg === '--port') options.port = parsePort(requiredValue(args, ++i, arg))
    else throw new Error(`Unknown option: ${arg}`)
  }
  return options
}

function requiredValue (args, index, option) {
  if (!args[index]) throw new Error(`${option} requires a value`)
  return args[index]
}

function parsePort (value) {
  const port = Number(value)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('--port must be an integer between 1 and 65535')
  }
  return port
}

function shortKey (key) {
  return key.toString('hex').slice(0, 12)
}

function printHelp () {
  console.log(`Usage: hyperdht-mdns-chat [options]

Run this command on three computers on the same LAN with the same --room.

Options:
  --name <name>  Name shown to the other test nodes
  --room <room>  Shared test room (default: hyperdht-mdns-test)
  --host <ip>    LAN IPv4 address to advertise (auto-selected by default)
  --port <port>  Fixed HyperDHT UDP port (default: 49799)
  -h, --help     Show this help`)
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
