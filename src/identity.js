'use strict'

const sodium = require('sodium-universal')

const NAMESPACE = Buffer.from('hyperdht-mdns/identity/1\n')

/**
 * The local network connects with a key made up for each network, so the
 * connection key does not say who a device is. A device that needs the other
 * side to know who it is, such as a member of the same room or another of the
 * person's own devices, says so inside the encrypted channel: it signs the
 * channel's handshake hash and both connection keys with its long-term key.
 *
 * The proof is only good for this one connection, so it cannot be replayed on
 * another one, and only the other end of the channel ever sees it. Decide who
 * gets it before sending it: whoever receives it can link this device across
 * networks.
 *
 * @param {{ publicKey: Buffer, secretKey: Buffer }} keyPair - The long-term key pair.
 * @param {{ handshakeHash: Buffer, publicKey: Buffer, remotePublicKey: Buffer }} connection
 * @param {string} [context] - What the proof is for, such as an application name.
 * @returns {{ publicKey: Buffer, signature: Buffer }}
 */
function createIdentityProof (keyPair, connection, context = '') {
  assertKeyPair(keyPair)
  const message = signable(context, connection.handshakeHash, connection.publicKey, connection.remotePublicKey)
  const signature = Buffer.alloc(sodium.crypto_sign_BYTES)
  sodium.crypto_sign_detached(signature, message, keyPair.secretKey)
  return { publicKey: Buffer.from(keyPair.publicKey), signature }
}

/**
 * The other side's long-term key when the proof it sent is good for this
 * connection, otherwise null.
 */
function verifyIdentityProof (proof, connection, context = '') {
  const publicKey = toBuffer(proof?.publicKey)
  const signature = toBuffer(proof?.signature)
  if (!publicKey || publicKey.byteLength !== sodium.crypto_sign_PUBLICKEYBYTES) return null
  if (!signature || signature.byteLength !== sodium.crypto_sign_BYTES) return null

  // Signed by the other side, so its connection key comes first.
  let message
  try {
    message = signable(context, connection.handshakeHash, connection.remotePublicKey, connection.publicKey)
  } catch {
    return null
  }
  if (!sodium.crypto_sign_verify_detached(signature, message, publicKey)) return null
  return publicKey
}

function signable (context, handshakeHash, signerKey, receiverKey) {
  for (const value of [handshakeHash, signerKey, receiverKey]) {
    if (!Buffer.isBuffer(value) && !(value instanceof Uint8Array)) {
      throw new TypeError('The connection must expose handshakeHash, publicKey and remotePublicKey')
    }
  }
  const digest = Buffer.alloc(32)
  sodium.crypto_generichash_batch(digest, [
    NAMESPACE,
    Buffer.from(String(context) + '\n'),
    handshakeHash,
    signerKey,
    receiverKey
  ])
  return digest
}

function toBuffer (value) {
  if (Buffer.isBuffer(value)) return value
  if (value instanceof Uint8Array) return Buffer.from(value.buffer, value.byteOffset, value.byteLength)
  if (typeof value === 'string' && /^[0-9a-f]+$/i.test(value) && value.length % 2 === 0) return Buffer.from(value, 'hex')
  return null
}

function assertKeyPair (keyPair) {
  if (!keyPair || !keyPair.publicKey || !keyPair.secretKey) {
    throw new TypeError('A long-term key pair with a secretKey is required')
  }
}

module.exports = { createIdentityProof, verifyIdentityProof }
