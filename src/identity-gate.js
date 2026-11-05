'use strict'

const Protomux = require('protomux')
const c = require('compact-encoding')
const sodium = require('sodium-universal')
const { createIdentityProof, verifyIdentityProof } = require('./identity')

const PROTOCOL = 'hyperdht-mdns/identity-gate/1'
const NAMESPACE = Buffer.from('hyperdht-mdns/identity-gate/1\n')
const TOKEN_BYTES = 32
const MAX_TOKENS = 512
// Lists are padded to a multiple of this with random tokens, so the length
// says little about how many rooms a device is in.
const PAD_TO = 16
const DEFAULT_TIMEOUT = 15_000

// The same bytes as c.array(c.fixed32), but a list longer than MAX_TOKENS is
// not read at all: it decodes to null, which closes the gate's channel and
// leaves the connection alone. Nobody honest sends more.
const tokenList = {
  preencode (state, list) {
    c.uint.preencode(state, list.length)
    state.end += list.length * TOKEN_BYTES
  },
  encode (state, list) {
    c.uint.encode(state, list.length)
    for (const token of list) c.fixed32.encode(state, token)
  },
  decode (state) {
    try {
      const length = c.uint.decode(state)
      if (length > MAX_TOKENS || length * TOKEN_BYTES > state.end - state.start) return null
      const list = new Array(length)
      for (let i = 0; i < length; i++) list[i] = c.fixed32.decode(state)
      return list
    } catch {
      return null
    }
  }
}

const identityMessage = {
  preencode (state, m) {
    c.uint8.preencode(state, 0)
    if (m) {
      c.fixed32.preencode(state, m.publicKey)
      c.fixed64.preencode(state, m.signature)
    }
  },
  encode (state, m) {
    c.uint8.encode(state, m ? 1 : 0)
    if (m) {
      c.fixed32.encode(state, m.publicKey)
      c.fixed64.encode(state, m.signature)
    }
  },
  decode (state) {
    if (c.uint8.decode(state) === 0) return null
    return { publicKey: c.fixed32.decode(state), signature: c.fixed64.decode(state) }
  }
}

/**
 * Who is on the other end of a local network connection, told only to
 * someone who shares a secret with this device, such as a room key or the key
 * that links a person's devices.
 *
 * Each side sends a token per secret, made from the secret and this
 * connection, padded with random ones. A token says nothing to someone
 * without that secret, and nothing on any other connection. Each side checks
 * the other's tokens against its own secrets, and declines when they share
 * none. Proofs of the long-term key (createIdentityProof) go in a fixed
 * order: the side that opened the connection proves first, once it has
 * matched a token; the other side proves only after that proof checked out
 * and `accept` said yes. So a side that matches a token and then declines
 * learns nothing from the side that proves second. The side that proves
 * first does prove itself to anyone who holds a secret it shares, so keep
 * those secrets to the people meant to have them. `accept` is the check on
 * who they are: a room's member list, or a person's linked devices.
 *
 * The result is the other side's long-term key and which secrets matched, or
 * null when nothing is shared, the other side declines or does not run the
 * gate, `accept` says no, or time runs out.
 *
 * Start it as soon as the connection opens, on both sides: protomux refuses a
 * channel the other side opens before this side has one. The key pair and the
 * secrets may be promises, for an app still loading them; the channel opens
 * at once and waits for them.
 *
 * @param {object} connection - A Noise stream (handshakeHash, publicKey, remotePublicKey, isInitiator).
 * @param {object} options
 * @param {{ publicKey: Buffer, secretKey: Buffer } | Promise} options.keyPair - This device's long-term key pair.
 * @param {Buffer[] | Promise<Buffer[]>} options.secrets - Secrets of 16 to 64 bytes.
 * @param {string} [options.context] - The application, so gates for different ones do not mix.
 * @param {number} [options.timeout]
 * @param {(publicKey: Buffer, matches: number[]) => boolean | Promise<boolean>} [options.accept] - Whether to go on with this key.
 * @returns {Promise<{ publicKey: Buffer, matches: number[] } | null>}
 */
function identityGate (connection, { keyPair, secrets = [], context = '', timeout = DEFAULT_TIMEOUT, accept = null } = {}) {
  return new Promise((resolve) => {
    let settled = false
    let matches = null
    let channel = null
    let timer = null
    let mine = null

    // A device with no key pair to prove with offers no real tokens either,
    // so it cannot learn who someone is without telling who it is.
    let queue = Promise.all([keyPair, secrets]).then(([pair, list]) => {
      const ok = isKeyPair(pair)
      mine = { pair: ok ? pair : null, usable: ok && Array.isArray(list) ? list.filter(isSecret).slice(0, MAX_TOKENS) : [] }
    }, () => {
      mine = { pair: null, usable: [] }
    })
    // What happens on the channel is taken in the order it happened, once the
    // key pair and secrets are in: the other side's proof before its channel
    // closing, which it does as soon as it has finished.
    const inOrder = (fn) => {
      queue = queue.then(fn).catch(() => finish(null))
    }

    const finish = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { channel?.close() } catch {}
      resolve(result)
    }

    try {
      channel = Protomux.from(connection).createChannel({
        protocol: PROTOCOL,
        id: Buffer.from(String(context)),
        onopen () {
          inOrder(() => {
            if (!settled) tokensChannel.send(ownTokens(mine.usable, connection, context))
          })
        },
        onclose () {
          inOrder(() => finish(null))
        }
      })
    } catch {
      return resolve(null)
    }
    if (!channel) return resolve(null)

    const tokensChannel = channel.addMessage({
      encoding: tokenList,
      onmessage (tokens) {
        inOrder(() => {
          if (settled || matches !== null) return
          if (tokens === null) return finish(null)
          matches = matching(mine.usable, tokens, connection, context)
          if (matches.length === 0) {
            identityChannel.send(null)
            return finish(null)
          }
          if (provesFirst(connection)) identityChannel.send(createIdentityProof(mine.pair, connection, context))
        })
      }
    })

    const identityChannel = channel.addMessage({
      encoding: identityMessage,
      onmessage (proof) {
        inOrder(async () => {
          if (settled) return
          // Only taken from a side this device has matched itself.
          if (!proof || !matches || matches.length === 0) return finish(null)
          const publicKey = verifyIdentityProof(proof, connection, context)
          const ok = !!publicKey && (!accept || await accept(publicKey, matches) === true)
          if (settled) return
          if (!provesFirst(connection)) identityChannel.send(ok ? createIdentityProof(mine.pair, connection, context) : null)
          finish(ok ? { publicKey, matches } : null)
        })
      }
    })

    timer = setTimeout(() => finish(null), timeout)
    timer.unref?.()
    channel.open()
  })
}

function ownTokens (secrets, connection, context) {
  const tokens = secrets.map((secret) => token(secret, connection.handshakeHash, connection.publicKey, context))
  const padded = Math.max(PAD_TO, Math.ceil(tokens.length / PAD_TO) * PAD_TO)
  while (tokens.length < Math.min(padded, MAX_TOKENS)) {
    const random = Buffer.alloc(TOKEN_BYTES)
    sodium.randombytes_buf(random)
    tokens.push(random)
  }
  return shuffle(tokens)
}

// The same side on both ends: the one that opened the connection, or for a
// stream that does not say, the one with the lower connection key.
function provesFirst (connection) {
  if (typeof connection.isInitiator === 'boolean') return connection.isInitiator
  return Buffer.compare(Buffer.from(connection.publicKey), Buffer.from(connection.remotePublicKey)) < 0
}

function matching (secrets, tokens, connection, context) {
  const received = new Set(tokens.map((value) => Buffer.from(value).toString('hex')))
  const found = []
  secrets.forEach((secret, index) => {
    const expected = token(secret, connection.handshakeHash, connection.remotePublicKey, context)
    if (received.has(expected.toString('hex'))) found.push(index)
  })
  return found
}

// Made with the sender's connection key, so the two directions differ.
function token (secret, handshakeHash, senderKey, context) {
  const out = Buffer.alloc(TOKEN_BYTES)
  sodium.crypto_generichash_batch(out, [
    NAMESPACE,
    Buffer.from(String(context) + '\n'),
    handshakeHash,
    senderKey
  ], secret)
  return out
}

function isKeyPair (pair) {
  return !!pair && isBytes(pair.publicKey, sodium.crypto_sign_PUBLICKEYBYTES) && isBytes(pair.secretKey, sodium.crypto_sign_SECRETKEYBYTES)
}

function isBytes (value, length) {
  return (Buffer.isBuffer(value) || value instanceof Uint8Array) && value.byteLength === length
}

function isSecret (secret) {
  return (Buffer.isBuffer(secret) || secret instanceof Uint8Array) &&
    secret.byteLength >= sodium.crypto_generichash_KEYBYTES_MIN &&
    secret.byteLength <= sodium.crypto_generichash_KEYBYTES_MAX
}

function shuffle (list) {
  for (let i = list.length - 1; i > 0; i--) {
    const j = sodium.randombytes_uniform(i + 1)
    const swap = list[i]
    list[i] = list[j]
    list[j] = swap
  }
  return list
}

module.exports = { identityGate, PROTOCOL }
