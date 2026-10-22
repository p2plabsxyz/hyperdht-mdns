'use strict'

// Hundreds of devices on one simulated LAN, in worker processes, with this
// process as the multicast network. Run: npm run test:stress -- --devices 300
//
// Checks, phase by phase:
// 1. mDNS seeds the DHT: every device ends up with a routing table, at most
//    maxSeeds seeds and maxDevices entries in its discovery list.
// 2. Rooms: everyone in one big room and each in a small one; a message in
//    every room reaches every member, with at most maxPeers connections each.
// 3. Devices leave without a goodbye: the rest drop them, and messages still
//    reach everyone left.
// 4. Airplane mode: devices go away, messages are sent, they come back on
//    new keys and catch up on everything they missed.
// 5. One hostile machine: many DHT nodes on one address, thousands of
//    made-up mDNS devices, request and announce floods. Honest devices keep
//    talking, latecomers still get in, and every table stays bounded.

const { fork } = require('child_process')
const { randomBytes } = require('crypto')
const path = require('path')
const { DEFAULT_LIMITS } = require('../..')

const args = Object.fromEntries(process.argv.slice(2).join(' ').split('--').filter(Boolean).map((part) => {
  const [key, value] = part.trim().split(/\s+/)
  return [key, Number(value)]
}))
const DEVICES = args.devices || 300
const WORKERS = args.workers || 10
const SMALL_ROOMS = args.rooms || 8
const BASE_PORT = 22000
const HOSTILE_PORTS = Array.from({ length: 60 }, (_, i) => 23000 + i)
// Every simulated device shares 127.0.0.1, so the per-address connection cap
// would treat them as one machine; test/lan.test.js covers that cap.
const LIMITS = { deviceTTL: 20_000, pingInterval: 5_000, sweepInterval: 2_000, connectionsPerIP: 1e9 }
const ANNOUNCE_INTERVAL = 5_000

const failures = []
const report = []
const check = (ok, message) => {
  if (!ok) failures.push(message)
  report.push(`${ok ? 'ok  ' : 'FAIL'} ${message}`)
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const bus = new Map()
const receipts = new Map()
const workers = []
let hostile = null
let pending = []

function broadcast (message) {
  for (const worker of workers) send(worker.child, message)
}

// A worker that already exited is skipped.
function send (child, message) {
  if (!child?.connected) return
  try {
    child.send(message)
  } catch {}
}

function watch (child) {
  // Writing to a worker that is shutting down fails with EPIPE; that is not
  // a result.
  child.on('error', () => {})
  return child
}

function onMessage (worker, message) {
  if (message.type === 'advertise') {
    bus.set(message.record.name, message.record)
    broadcast({ cmd: 'service', record: message.record })
  } else if (message.type === 'stop') {
    bus.delete(message.name)
    if (message.goodbye) broadcast({ cmd: 'down', name: message.name, port: message.port })
  } else if (message.type === 'query') {
    for (const record of bus.values()) send(worker.child, { cmd: 'service', record })
  } else if (message.type === 'received') {
    if (!receipts.has(message.id)) receipts.set(message.id, new Map())
    receipts.get(message.id).set(message.port, message.at)
  } else if (message.type === 'error') {
    failures.push(`worker error: ${message.message}`)
  } else {
    pending = pending.filter((entry) => !entry.match(message) || (entry.resolve(message), false))
  }
}

function request (worker, command, match) {
  return new Promise((resolve) => {
    pending.push({ match: (message) => message.worker === worker && match(message), resolve })
    send(worker.child, command)
  })
}

async function allStats (names = false) {
  const results = await Promise.all(workers.map((worker) => request(worker, { cmd: 'stats', names }, (m) => m.type === 'stats')))
  return {
    devices: results.flatMap((result) => result.stats),
    memory: results.map((result) => result.memory)
  }
}

async function spread (room, members, from, { timeout = 30_000 } = {}) {
  const id = randomBytes(8).toString('hex')
  const started = Date.now()
  const owner = workers.find((worker) => worker.ports.includes(from))
  send(owner.child, { cmd: 'originate', port: from, room, id })
  const want = new Set(members)
  while (Date.now() - started < timeout) {
    const got = receipts.get(id)
    if (got && [...want].every((port) => got.has(port))) break
    await sleep(100)
  }
  const got = receipts.get(id) || new Map()
  const reached = [...want].filter((port) => got.has(port))
  const latencies = reached.map((port) => got.get(port) - started).sort((a, b) => a - b)
  return {
    id,
    coverage: reached.length / want.size,
    missing: [...want].filter((port) => !got.has(port)),
    p50: latencies[Math.floor(latencies.length / 2)] || 0,
    p95: latencies[Math.floor(latencies.length * 0.95)] || 0,
    max: latencies.at(-1) || 0
  }
}

function summarize (devices) {
  const max = (key) => Math.max(...devices.map((device) => device[key]))
  const avg = (key) => Math.round(devices.reduce((sum, device) => sum + device[key], 0) / devices.length)
  return `devices ${devices.length}, routing table avg ${avg('nodes')} max ${max('nodes')}, seeds max ${max('seeds')}, discovery list max ${max('devices')}, connections avg ${avg('connections')} max ${max('connections')}`
}

async function main () {
  const started = Date.now()
  const ports = Array.from({ length: DEVICES }, (_, i) => BASE_PORT + i)
  for (let w = 0; w < WORKERS; w++) {
    const mine = ports.filter((_, i) => i % WORKERS === w)
    const child = watch(fork(path.join(__dirname, 'worker.js'), [JSON.stringify({ index: w, ports: mine, limits: LIMITS, announceInterval: ANNOUNCE_INTERVAL })]))
    const worker = { child, ports: mine }
    child.on('message', (message) => onMessage(worker, { ...message, worker }))
    workers.push(worker)
  }
  await Promise.all(workers.map((worker) => request(worker, { cmd: 'start' }, (m) => m.type === 'started')))

  // 1. Bootstrap.
  let stats
  const bootDeadline = Date.now() + 90_000
  do {
    await sleep(2000)
    stats = await allStats()
  } while (stats.devices.some((device) => device.nodes < 8) && Date.now() < bootDeadline)
  report.push(`bootstrap after ${Math.round((Date.now() - started) / 1000)} s: ${summarize(stats.devices)}; memory per worker ${Math.round(Math.max(...stats.memory) / 1e6)} MB at most`)
  check(stats.devices.every((device) => device.nodes >= 8), 'every device has a routing table of 8 or more')
  check(stats.devices.every((device) => device.seeds <= DEFAULT_LIMITS.maxSeeds), `at most ${DEFAULT_LIMITS.maxSeeds} seeds from mDNS`)
  check(stats.devices.every((device) => device.devices <= DEFAULT_LIMITS.maxDevices), `at most ${DEFAULT_LIMITS.maxDevices} entries in the discovery list`)
  check(new Set(stats.devices.map((device) => device.key)).size === DEVICES, 'every device has its own made-up key')

  // 2. Rooms.
  const big = randomBytes(32).toString('hex')
  const small = Array.from({ length: SMALL_ROOMS }, () => randomBytes(32).toString('hex'))
  const membership = new Map(ports.map((port) => [port, [big, small[Math.floor(Math.random() * small.length)]]]))
  for (const worker of workers) {
    send(worker.child, { cmd: 'join', rooms: Object.fromEntries(worker.ports.map((port) => [port, membership.get(port)])) })
  }
  await sleep(20_000)
  stats = await allStats()
  report.push(`rooms joined: ${summarize(stats.devices)}; memory per worker ${Math.round(Math.max(...stats.memory) / 1e6)} MB at most`)
  check(stats.devices.every((device) => device.seeds <= DEFAULT_LIMITS.maxSeeds), `still at most ${DEFAULT_LIMITS.maxSeeds} seeds`)
  check(stats.devices.every((device) => device.connections <= DEFAULT_LIMITS.maxPeers), `at most ${DEFAULT_LIMITS.maxPeers} connections per device`)
  const members = (room, present) => [...membership].filter(([port, rooms]) => rooms.includes(room) && present.has(port)).map(([port]) => port)
  let present = new Set(ports)
  for (const room of [big, ...small]) {
    const who = members(room, present)
    if (who.length === 0) continue
    const result = await spread(room, who, who[Math.floor(Math.random() * who.length)])
    report.push(`  ${room === big ? 'big room' : 'small room'} of ${who.length}: ${Math.round(result.coverage * 100)}% in p50 ${result.p50} ms, p95 ${result.p95} ms, max ${result.max} ms`)
    check(result.coverage === 1, `a message in a room of ${who.length} reaches every member`)
  }

  // 3. Leaving without a goodbye.
  const shuffled = ports.slice().sort(() => Math.random() - 0.5)
  const gone = shuffled.slice(0, Math.round(DEVICES * 0.1))
  for (const worker of workers) {
    const mine = worker.ports.filter((port) => gone.includes(port))
    if (mine.length) await request(worker, { cmd: 'vanish', ports: mine }, (m) => m.type === 'done')
  }
  present = new Set(ports.filter((port) => !gone.includes(port)))
  await sleep(LIMITS.deviceTTL + 4 * LIMITS.pingInterval + 10_000)
  stats = await allStats(true)
  const stale = stats.devices.reduce((sum, device) => sum + device.deviceNames.filter((port) => gone.includes(port)).length, 0)
  report.push(`${gone.length} devices left without a goodbye: ${stale} stale entries left anywhere`)
  check(stale === 0, 'devices gone without a goodbye drop out of every discovery list')
  let result = await spread(big, members(big, present), [...present][0])
  report.push(`  big room after: ${Math.round(result.coverage * 100)}% of ${present.size} in max ${result.max} ms`)
  check(result.coverage === 1, 'messages still reach everyone left')

  // 4. Airplane mode.
  const away = [...present].sort(() => Math.random() - 0.5).slice(0, Math.round(DEVICES * 0.1))
  const keysBefore = new Map(stats.devices.filter((device) => away.includes(device.port)).map((device) => [device.port, device.key]))
  for (const worker of workers) {
    const mine = worker.ports.filter((port) => away.includes(port))
    if (mine.length) await request(worker, { cmd: 'away', ports: mine }, (m) => m.type === 'done')
  }
  const stillHere = new Set([...present].filter((port) => !away.includes(port)))
  const missed = []
  for (const room of [big, small[0], small[1]]) {
    const who = members(room, stillHere)
    if (who.length) missed.push({ room, ...(await spread(room, who, who[0], { timeout: 15_000 })) })
  }
  await sleep(5000)
  for (const worker of workers) {
    const mine = worker.ports.filter((port) => away.includes(port))
    if (mine.length) await request(worker, { cmd: 'back', ports: mine }, (m) => m.type === 'done')
  }
  const backStarted = Date.now()
  let caughtUp = 0
  const expected = away.flatMap((port) => missed.filter((message) => membership.get(port).includes(message.room)).map((message) => [port, message.id]))
  while (Date.now() - backStarted < 60_000) {
    caughtUp = expected.filter(([port, id]) => receipts.get(id)?.has(port)).length
    if (caughtUp === expected.length) break
    await sleep(500)
  }
  stats = await allStats()
  const newKeys = stats.devices.filter((device) => keysBefore.has(device.port) && keysBefore.get(device.port) !== device.key).length
  report.push(`${away.length} devices went away and came back: ${caughtUp}/${expected.length} missed messages caught up in ${Math.round((Date.now() - backStarted) / 1000)} s, ${newKeys} on new keys`)
  check(caughtUp === expected.length, 'devices back from airplane mode get everything sent while they were away')
  check(newKeys === away.length, 'each comes back on a new key')

  // 5. A hostile machine.
  hostile = watch(fork(path.join(__dirname, 'hostile.js'), [JSON.stringify({ ports: HOSTILE_PORTS, targets: [...present], topic: big, fakeNames: 3000 })]))
  const hostileWorker = { child: hostile, ports: HOSTILE_PORTS }
  hostile.on('message', (message) => onMessage(hostileWorker, { ...message, worker: hostileWorker }))
  await new Promise((resolve) => { pending.push({ match: (m) => m.type === 'started' && m.worker === hostileWorker, resolve }) })
  await sleep(20_000)
  result = await spread(big, members(big, present), [...present][1])
  report.push(`under attack, big room: ${Math.round(result.coverage * 100)}% of ${present.size} in p95 ${result.p95} ms`)
  check(result.coverage === 1, 'under attack, messages still reach every honest device')

  // Latecomers arrive during the attack.
  const late = Array.from({ length: 5 }, (_, i) => BASE_PORT + DEVICES + i)
  const lateWorker = watch(fork(path.join(__dirname, 'worker.js'), [JSON.stringify({ index: 99, ports: late, limits: LIMITS, announceInterval: ANNOUNCE_INTERVAL })]))
  const latecomers = { child: lateWorker, ports: late }
  lateWorker.on('message', (message) => onMessage(latecomers, { ...message, worker: latecomers }))
  workers.push(latecomers)
  await request(latecomers, { cmd: 'start' }, (m) => m.type === 'started')
  for (const port of late) membership.set(port, [big])
  send(lateWorker, { cmd: 'join', rooms: Object.fromEntries(late.map((port) => [port, [big]])) })
  for (const port of late) present.add(port)
  await sleep(15_000)
  result = await spread(big, late, [...present][2], { timeout: 30_000 })
  report.push(`latecomers during the attack: ${Math.round(result.coverage * 100)}% got the next message`)
  check(result.coverage === 1, 'latecomers find the room during the attack')

  stats = await allStats()
  const totals = stats.devices.reduce((sum, device) => {
    sum.requests += device.stats.droppedRequests || 0
    sum.announces += device.stats.droppedAnnounces || 0
    sum.sightings += device.stats.sightingsDropped || 0
    sum.refused += device.stats.devicesRefused || 0
    sum.nodes += device.stats.refusedNodes || 0
    return sum
  }, { requests: 0, announces: 0, sightings: 0, refused: 0, nodes: 0 })
  report.push(`dropped: ${totals.requests} requests, ${totals.announces} announcements, ${totals.sightings} mDNS sightings; refused ${totals.refused} devices, ${totals.nodes} routing entries`)
  check(stats.devices.every((device) => device.hostileDevices <= DEFAULT_LIMITS.devicesPerIP), `at most ${DEFAULT_LIMITS.devicesPerIP} hostile entries in any discovery list`)
  check(stats.devices.every((device) => device.hostileNodes <= DEFAULT_LIMITS.nodesPerIP), `at most ${DEFAULT_LIMITS.nodesPerIP} hostile nodes in any routing table`)
  check(stats.devices.every((device) => device.connections <= DEFAULT_LIMITS.maxPeers), `still at most ${DEFAULT_LIMITS.maxPeers} connections per device`)
  report.push(`${summarize(stats.devices)}; memory per worker ${Math.round(Math.max(...stats.memory) / 1e6)} MB at most`)
}

main()
  .catch((error) => failures.push(error.stack))
  .finally(async () => {
    console.log(report.join('\n'))
    send(hostile, { cmd: 'stop' })
    for (const worker of workers) send(worker.child, { cmd: 'stop' })
    await sleep(3000)
    if (failures.length) {
      console.log(`\n${failures.length} failed:\n${failures.join('\n')}`)
      process.exit(1)
    }
    console.log('\nall checks passed')
    process.exit(0)
  })
