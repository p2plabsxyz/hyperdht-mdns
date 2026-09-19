'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const path = require('node:path')

// The adapter seam exists so a runtime without Node's dgram/os can supply its
// own mDNS. That only holds if bonjour-service is never loaded unless it is
// actually used, so these tests pin the loading, not just the behaviour.
//
// They run in child processes because module loading is global: a require
// anywhere else in the suite would mask a regression. `-e` scripts have no
// module path of their own, hence the absolute root.

const ROOT = path.join(__dirname, '..')
const REQUIRE_ROOT = `require(${JSON.stringify(ROOT)})`

function bonjourLoadedBy (source) {
  // The child exits explicitly: constructing an instance opens sockets that
  // would otherwise hold the loop open and hang the run.
  const script = `
    ${source}
    const loaded = Object.keys(require.cache).some((p) => p.includes('bonjour-service'))
    process.stdout.write(loaded ? 'loaded' : 'absent')
    process.exit(0)
  `

  return execFileSync(process.execPath, ['-e', script], { cwd: ROOT, timeout: 30000 }).toString()
}

test('requiring the package does not load bonjour-service', () => {
  assert.equal(bonjourLoadedBy(REQUIRE_ROOT), 'absent')
})

test('constructing with a custom adapter does not load bonjour-service', () => {
  const source = `
    const HyperDHTmDNS = ${REQUIRE_ROOT}
    const adapter = {
      advertise () { return { stop: async () => {} } },
      browse () { return { stop: async () => {} } }
    }
    const lan = new HyperDHTmDNS({ adapter, port: 49877 })
    if (lan.adapter !== adapter) throw new Error('the supplied adapter was not used')
  `

  assert.equal(bonjourLoadedBy(source), 'absent')
})

test('the default adapter is still used when none is supplied', () => {
  const source = `
    const HyperDHTmDNS = ${REQUIRE_ROOT}
    const lan = new HyperDHTmDNS({ port: 49878 })
    if (typeof lan.adapter.advertise !== 'function') throw new Error('no default adapter')
  `

  assert.equal(bonjourLoadedBy(source), 'loaded')
})

test('the BonjourAdapter export still resolves', () => {
  const { BonjourAdapter } = require('..')

  assert.equal(typeof BonjourAdapter, 'function')
  assert.equal(bonjourLoadedBy(`${REQUIRE_ROOT}.BonjourAdapter`), 'loaded')
})
