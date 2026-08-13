'use strict'

const Corestore = require('corestore')
const HyperswarmLAN = require('..')

async function main () {
  const store = new Corestore('./userData/hyper')
  const lan = new HyperswarmLAN({ port: 49799 })

  lan.on('connection', (socket) => store.replicate(socket))
  lan.on('warning', console.warn)

  await store.ready()
  await lan.ready()

  const core = store.get({ name: 'messages', valueEncoding: 'utf-8' })
  await core.ready()
  lan.join(core.discoveryKey)

  console.log(`LAN DHT listening on UDP ${lan.port}`)
  console.log(`Core key: ${core.key.toString('hex')}`)
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
